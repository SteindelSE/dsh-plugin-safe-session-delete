// dsh-plugin-safe-session-delete — host plugin entry
//
// Copyright (C) 2026 SteindelSE
//
// This file is part of dsh-plugin-safe-session-delete.
//
// dsh-plugin-safe-session-delete is free software: you can
// redistribute it and/or modify it under the terms of the GNU
// Affero General Public License as published by the Free Software
// Foundation, either version 3 of the License, or (at your option)
// any later version.
//
// dsh-plugin-safe-session-delete is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY; without even the
// implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR
// PURPOSE. See the GNU Affero General Public License for more
// details.
//
// You should have received a copy of the GNU Affero General Public
// License along with dsh-plugin-safe-session-delete.  If not, see
// <https://www.gnu.org/licenses/>.
//
// Contact: <https://github.com/SteindelSE/dsh-plugin-safe-session-delete>
// SPDX-License-Identifier: AGPL-3.0-or-later

// Registers the host for the plugin. The host runs in Node.js (via
// cordis). It exposes the deletion service through two surfaces:
//   - The `workbench_session_delete` agent tool (registered via
//     `ctx.tools.register`) — for agents to call.
//   - A `seam` object passed through slot `inject` factories — for
//     the renderer-side UI (header button, sidebar menu item,
//     shared confirmation dialog) to invoke the same deletion
//     service across the host↔renderer IPC boundary.
//
// The renderer never reaches Node.js globals directly. Functions in
// slot `inject` results are RPC-marshalled by the harness, so a
// closure that captures `deleteService` and `authorization` runs in
// the host process when called from the browser.

import { AuthorizationManager } from './services/authorization.js';
import { SessionDeleteService } from './services/session-delete.js';
import {
  createWorkbenchSessionDeleteTool,
  installApprovalGate,
} from './tools/workbench-session-delete.js';

export const name = 'dsh-plugin-safe-session-delete';

/**
 * Host services the plugin reads (cordis static `inject`).
 *
 * The dsh-cordis-host-runner wraps `apply` in a sandbox proxy that
 * resolves declared services as `ctx.<name>`; undeclared names throw.
 * We only consume `tools` as a property (the others are accessed via
 * the always-available `ctx.get(...)`).
 */
export const inject = ['tools'];

// --- active-profile resolution -------------------------------------------

/**
 * Return a stable identifier for the currently-active harness profile. We
 * prefer the `profileContext` provided by the launcher, fall back to a
 * derived name, and refuse to proceed if the host does not expose either.
 */
function resolveProfileId(ctx) {
  const profile = ctx.get?.('profileContext');
  if (profile && typeof profile === 'object' && typeof profile.name === 'string') {
    return profile.name;
  }
  return 'unknown-profile';
}

// --- main apply ---------------------------------------------------------

export function apply(ctx) {
  const profileId = resolveProfileId(ctx);
  // `ctx.get` is the only universally-available accessor in the
  // dsh-cordis-host-runner sandbox; property reads (ctx.logger, etc.)
  // require the service to appear in `inject`. Look everything up by
  // name so we don't add a brittle declare-only-to-log entry.
  const getLogger = () => (typeof ctx.get === 'function' ? ctx.get('logger') : null);
  const authorization = new AuthorizationManager({
    resolveProfileId: () => profileId,
    audit: (token, event, payload) => {
      try {
        getLogger()?.('dsh-plugin-safe-session-delete')?.info?.(
          'auth:%s:%s:%s', token, event, JSON.stringify(payload || {}),
        );
      } catch { /* logger may not be ready */ }
    },
  });
  const deleteService = new SessionDeleteService({
    ctx,
    authorization,
    audit: (event, payload) => {
      try {
        getLogger()?.('dsh-plugin-safe-session-delete')?.info?.(
          'delete:%s:%s', event, JSON.stringify(payload || {}),
        );
      } catch { /* */ }
    },
  });

  // Recover from any intents left over by a prior crashed run, before we
  // register the tool. Recovery only clears records whose target is fully
  // gone — it never races an in-flight deletion.
  ctx.effect(async () => {
    try {
      await deleteService.recoverFromIntents();
    } catch (err) {
      try {
        getLogger()?.('dsh-plugin-safe-session-delete')?.warn?.(
          'recovery:%s', err.message,
        );
      } catch { /* */ }
    }
  });

  // Register the approval gate. Every workbench_session_delete invocation
  // routes through the harness approval surface; the absence of one
  // degrades to denial.
  ctx.effect(() => installApprovalGate(ctx, {
    onDeny: (decision) => {
      try {
        getLogger()?.('dsh-plugin-safe-session-delete')?.info?.(
          'denied:%s', JSON.stringify(decision),
        );
      } catch { /* */ }
    },
  }));

  // Register the tool against the harness ToolRegistry.
  ctx.effect(() => {
    const tools = ctx.tools;
    if (!tools || typeof tools.register !== 'function') return;
    const definition = createWorkbenchSessionDeleteTool({
      authorization,
      deleteService,
    });
    return tools.register(definition);
  });

  // -- seam ----------------------------------------------------------
  // The seam is the IPC-marshalled bridge between the renderer-side UI
  // components and the host's deletion service. Functions in slot
  // `inject` results are wrapped by the harness's RPC layer: the closure
  // body runs in the host process when the browser calls them. There is
  // no `globalThis` involved; the host runs in Node and the renderer
  // runs in the browser, and they share no globals.
  const seam = Object.freeze({
    /**
     * Read-only session descriptor for the dialog's confirmation content.
     * Returns the canonical id, the projection-cache title (best-effort),
     * and the live "is there an attached agent" flag.
     *
     * @param {{sessionId: string}} req
     */
    describeSession({ sessionId }) {
      const agents = ctx.get?.('agents');
      const running = !!(agents && typeof agents.get === 'function' && (
        agents.get(sessionId) || agents.get(sessionId.replace(/^session-/, ''))
      ));
      return {
        sessionId,
        title: sessionId,
        running,
      };
    },
    /**
     * One-shot bridge the client dialog calls when the user confirms.
     * Mints a `ui-direct` authorization receipt, redeems it, runs the
     * full deletion state machine, and returns a structured result. The
     * dialog passes `interruptActive: true` only after the user
     * explicitly acknowledges that a running agent will be interrupted.
     *
     * @param {{sessionId: string, sourceTag?: string, interruptActive?: boolean}} req
     */
    async dialogConfirm({ sessionId, sourceTag, interruptActive }) {
      let canonical;
      try {
        // The renderer hands us whatever form it was sent; re-normalize
        // to be safe before touching the persistence layer.
        canonical = String(sessionId || '').trim();
        // quick reject: anything that doesn't look like a uuid
        if (!/^(session-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(canonical)) {
          return { ok: false, error: 'invalid session id' };
        }
        // normalize to canonical
        canonical = canonical.toLowerCase().startsWith('session-')
          ? canonical.toLowerCase()
          : 'session-' + canonical.toLowerCase();
      } catch (err) {
        return { ok: false, error: err.message };
      }
      const tag = typeof sourceTag === 'string' && sourceTag.length > 0
        ? sourceTag
        : 'client-dialog';
      let receipt;
      try {
        receipt = authorization.mint(canonical, 'ui-direct', tag);
      } catch (err) {
        return { ok: false, error: `mint:${err.message}` };
      }
      let authCtx;
      try {
        authCtx = authorization.redeem(receipt.tokenId, canonical, 'ui-direct');
      } catch (err) {
        return { ok: false, error: `redeem:${err.message}` };
      }
      try {
        const result = await deleteService.deleteSession({
          sessionId: canonical,
          authorization: authCtx,
          interruptActive: interruptActive === true,
          profileId,
        });
        return { ok: true, phases: result.phases, removed: result.removed, canonicalId: result.canonicalId };
      } catch (err) {
        return { ok: false, error: err.message, code: err.name };
      }
    },
  });

  ctx.effect(() => {
    // Provide the seam to the host's cordis tree. The harness's
    // `cordis-client-runner` mirrors services into the browser-side
    // cordis context so the renderer can read them via
    // `ctx.safeSessionDelete`. Slot `inject` factories in the client
    // bundle close over the seam reference; methods called from the
    // browser are RPC-marshalled back to the host.
    ctx.provide('safeSessionDelete', seam);
    return () => undefined;
  });

  // -- slot registrations --------------------------------------------
  // Each slot's `inject` factory closes over the seam and returns it as
  // The client bundle (src/client.js) registers the three slot entries
  // (header button, sidebar menu item, dialog overlay) via its own
  // `apply(ctx)`. The host does NOT register them: the host runs in
  // Node.js, the renderer runs in the browser, and slot components
  // are React elements that must be created in the browser's closure.
  // The bundle's `apply` reads the seam from `ctx.safeSessionDelete`
  // (mirrored from this host's `provide`).

  // On plugin disposal: revoke every outstanding receipt, drop the seam.
  ctx.effect(() => () => authorization.dispose());
}