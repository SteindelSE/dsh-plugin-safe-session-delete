// dsh-plugin-safe-session-delete — workbench-session-delete tool
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
// License along with dsh-plugin-safe-session-delete. If not, see
// <https://www.gnu.org/licenses/>.
//
// Contact: <https://github.com/SteindelSE/dsh-plugin-safe-session-delete>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The harness-callable agent tool. The tool is registered with a
// `tools/pre-execute` listener that ALWAYS returns `{ kind: 'ask' }`, so
// every invocation must pass through the harness approval surface. If
// the harness exposes no approval service, the registry comment is
// explicit: missing approval support turns `ask` into denial.
//
// Security properties:
//   - The tool rejects self-deletion: a model that tries to delete its
//     own session is denied.
//   - The tool refuses without a target-bound, human-issued authorization
//     token. The token is minted by the harness approval surface (or by
//     the UI directly) and redeemed via the plugin's AuthorizationManager.
//   - The tool routes through the central SessionDeleteService — it has
//     no direct filesystem access.
//   - The tool refuses any session id whose canonical spelling does not
//     resolve to exactly one persisted session.
//
// Output contract: returns a frozen string value summarizing the phases
// reached. Errors are structured as HarnessError via the registry's
// ToolArgsError / post-policy path.

import { defineTool } from '@deepseek-ai/dsh-tools';

import {
  normalizeSessionId,
} from '../services/session-resolver.js';
import { TOKEN_KINDS } from '../services/authorization.js';
import {
  callTargetsOwnSession,
} from '../services/session-lifecycle.js';
import {
  SessionDeleteService,
  DeleteValidationError,
  DeleteAuthorizationFailedError,
  DeleteQuiescenceError,
  DeleteFlushError,
  DeleteVerificationError,
} from '../services/session-delete.js';

/**
 * Build the workbench_session_delete tool definition.
 *
 * @param {object} deps
 * @param {AuthorizationManager} deps.authorization
 * @param {SessionDeleteService} deps.deleteService
 * @returns {import('@deepseek-ai/dsh-tools').ToolDefinition}
 */
export function createWorkbenchSessionDeleteTool({ authorization, deleteService }) {
  if (!authorization) throw new Error('workbench-session-delete requires authorization manager');
  if (!deleteService) throw new Error('workbench-session-delete requires deleteService');
  return defineTool({
    name: 'workbench_session_delete',
    description:
      'Permanently delete one session of the workbench. Cancels any running agent, ' +
      'removes its persisted log, projection-cache row, and workspace accounting. ' +
      'Requires explicit, single-use user authorization — every invocation is ' +
      'shown to the user for approval before the destructive action runs. ' +
      'Refuses self-deletion. Returns a summary of the phases reached.',
    parameters: {
      sessionId: {
        type: 'string',
        required: true,
        description:
          'The exact session id (uuid or session-<uuid> form) to delete. Must be ' +
          'obtained from the authoritative session list — never from a title match.',
      },
      authorizationToken: {
        type: 'string',
        required: true,
        description:
          'A target-bound authorization token previously minted by the user pressing ' +
          'the Delete Permanently button or approving the deletion request through ' +
          'the harness approval surface. Single-use; replay or cross-session reuse is ' +
          'rejected.',
      },
      interruptActive: {
        type: 'boolean',
        description:
          'Set to true ONLY after the user has explicitly acknowledged that the ' +
          'target session is running and that the deletion will interrupt its agent. ' +
          'Required when the session is currently running; ignored otherwise.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          canonicalId: { type: 'string' },
          phases: { type: 'array' },
          removed: {
            type: 'object',
            additionalProperties: false,
            properties: {
              workspaceClaims: { type: 'integer' },
              archivedRemoved: { type: 'boolean' },
              projSpelling: {
                oneOf: [
                  { type: 'string' },
                  { type: 'null' },
                ],
              },
              sessionDir: { type: 'boolean' },
            },
          },
        },
      },
      render(_args, value) {
        const text = [
          `Deleted session ${value.canonicalId}`,
          `Phases: ${value.phases.join(', ')}`,
          `Workspace claims removed: ${value.removed.workspaceClaims}`,
          `Archived flag cleared: ${value.removed.archivedRemoved}`,
          `Projection cache row removed: ${value.removed.projSpelling || 'none'}`,
          `Session log directory removed: ${value.removed.sessionDir}`,
        ].join('\n');
        return [{ type: 'text', text }];
      },
    },
    /**
     * @param {{sessionId: string, authorizationToken: string, interruptActive?: boolean}} args
     * @param {import('@deepseek-ai/dsh-tools').ToolRunContext} exec
     */
    async execute(args, exec) {
      // Self-deletion check.
      let canonicalId;
      try {
        canonicalId = normalizeSessionId(args.sessionId);
      } catch (err) {
        throw new DeleteValidationError(err.message);
      }
      if (callTargetsOwnSession(exec, canonicalId)) {
        throw new DeleteAuthorizationFailedError(
          'an agent may not delete its own executing session',
        );
      }

      // Redeem the authorization token. This is a synchronous check —
      // single-use enforcement happens here.
      let authContext;
      try {
        authContext = authorization.redeem(
          args.authorizationToken,
          canonicalId,
          TOKEN_KINDS.UI_AGENT_APPROVAL,
        );
      } catch (err) {
        if (err instanceof Error) {
          throw new DeleteAuthorizationFailedError(err.message, err);
        }
        throw err;
      }

      const result = await deleteService.deleteSession({
        sessionId: canonicalId,
        authorization: authContext,
        interruptActive: args.interruptActive === true,
        profileId: authContext.profileId,
      });
      return result;
    },
  });
}

/**
 * Install the `tools/pre-execute` listener that turns every invocation
 * into an approval request. If the host has no approval service, the
 * registry degrades to denial (see PreToolDecision docstring in
 * dsh-tools/lib/types/index.d.ts).
 *
 * @param {object} ctx - cordis host context (must expose `ctx.on`).
 * @param {object} [options]
 * @param {(decision: object) => void} [options.onDeny] - diagnostics hook.
 * @returns {() => void} dispose function.
 */
export function installApprovalGate(ctx, options) {
  if (!ctx || typeof ctx.on !== 'function' && typeof ctx.once !== 'function') {
    throw new Error('installApprovalGate requires a cordis ctx with on/once');
  }
  const on = ctx.on || ctx.once;
  const onDeny = options && typeof options.onDeny === 'function' ? options.onDeny : () => {};
  const handler = async (exec) => {
    if (!exec || exec.name !== 'workbench_session_delete') return { kind: 'allow' };
    // The decision object is consumed by the registry; ask routes
    // through the approval surface if mounted, else denies.
    return {
      kind: 'ask',
      reason: 'workbench_session_delete requires explicit user authorization before destructive session deletion',
      displayReason: {
        en: 'Workbench session deletion requires your explicit confirmation. Approve to permanently delete this session.',
      },
    };
  };
  // The registry uses ctx.on('tools/pre-execute', ...) to register the
  // waterfall listener.
  const dispose = on.call(ctx, 'tools/pre-execute', handler);
  return typeof dispose === 'function' ? dispose : () => {};
}