(() => {
  // src/client.entry.js
  window.__ModuleLoader__.load({
    id: "dsh-plugin-safe-session-delete/client",
    factory: function(require2) {
      "use strict";
      var module = { exports: {} };
      var exports = module.exports;
      Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
      var React = require2("react");
      var jsxRuntime = require2("react/jsx-runtime");
      var dialogState = {
        open: false,
        sessionId: null,
        title: null,
        running: false,
        acknowledged: false,
        interruptAcknowledged: false,
        busy: false,
        error: null,
        sourceTag: null
      };
      var subscribers = /* @__PURE__ */ new Set();
      function notify() {
        for (var s of subscribers) s();
      }
      function openDialog(sessionId, sourceTag, descriptor) {
        dialogState.open = true;
        dialogState.sessionId = sessionId;
        dialogState.sourceTag = sourceTag || "client";
        dialogState.title = descriptor && descriptor.title || sessionId;
        dialogState.running = !!(descriptor && descriptor.running);
        dialogState.acknowledged = false;
        dialogState.interruptAcknowledged = false;
        dialogState.busy = false;
        dialogState.error = null;
        notify();
      }
      function closeDialog() {
        dialogState.open = false;
        dialogState.sessionId = null;
        dialogState.sourceTag = null;
        dialogState.error = null;
        dialogState.acknowledged = false;
        dialogState.interruptAcknowledged = false;
        dialogState.busy = false;
        notify();
      }
      function setAcknowledged(v) {
        dialogState.acknowledged = !!v;
        if (!v) dialogState.interruptAcknowledged = false;
        notify();
      }
      function setInterruptAcknowledged(v) {
        dialogState.interruptAcknowledged = !!v;
        notify();
      }
      function setBusy(v) {
        dialogState.busy = !!v;
        notify();
      }
      function setError(msg) {
        dialogState.error = msg;
        notify();
      }
      function useDialogState() {
        var forceUpdate = React.useReducer(function(s) {
          return s + 1;
        }, 0)[1];
        React.useEffect(function() {
          var sub = function() {
            forceUpdate();
          };
          subscribers.add(sub);
          return function() {
            subscribers.delete(sub);
          };
        }, [forceUpdate]);
        return dialogState;
      }
      function HeaderButton(props) {
        var sessionId = props && props.sessionId;
        var seam = props && props.seam;
        if (!sessionId || !seam) return null;
        return jsxRuntime.jsx("button", {
          type: "button",
          className: "sdsh-header-button",
          "aria-label": "Delete session permanently",
          title: "Delete session permanently",
          onClick: function() {
            openFromTarget("header", sessionId, seam);
          },
          children: jsxRuntime.jsx("span", { className: "sdsh-icon", "aria-hidden": "true", children: "\u2716" })
        });
      }
      function SidebarItem(props) {
        var sessionId = props && props.sessionId;
        var seam = props && props.seam;
        var setMenuOpen = props && props.useMenuOpenState ? props.useMenuOpenState()[1] : null;
        if (!sessionId || !seam) return null;
        return jsxRuntime.jsx("button", {
          type: "button",
          role: "menuitem",
          className: "sdsh-menu-item",
          onClick: function() {
            if (setMenuOpen) {
              try {
                setMenuOpen(false);
              } catch {
              }
            }
            openFromTarget("sidebar", sessionId, seam);
          },
          children: "Delete session"
        });
      }
      function DeleteDialog(props) {
        var state = useDialogState();
        var seam = props && props.seam;
        if (!state.open || !state.sessionId) return null;
        var canConfirm = state.acknowledged && (!state.running || state.interruptAcknowledged) && !state.busy;
        return jsxRuntime.jsx("div", {
          className: "sdsh-overlay-backdrop",
          onClick: function(e) {
            if (e && e.target === e.currentTarget && !state.busy) closeDialog();
          },
          role: "presentation",
          children: jsxRuntime.jsxs("div", {
            className: "sdsh-overlay-modal",
            role: "dialog",
            "aria-modal": "true",
            "aria-labelledby": "sdsh-title",
            children: [
              jsxRuntime.jsx("h2", { id: "sdsh-title", className: "sdsh-title", children: "Delete session permanently?" }),
              jsxRuntime.jsxs("dl", { className: "sdsh-meta", children: [
                jsxRuntime.jsxs("dt", { children: "Session" }, []),
                jsxRuntime.jsxs("dd", { children: [
                  jsxRuntime.jsx("code", { children: state.sessionId }),
                  state.title && state.title !== state.sessionId ? jsxRuntime.jsxs("span", { className: "sdsh-meta-sub", children: [" \u2014 ", state.title] }) : null
                ] }, []),
                jsxRuntime.jsxs("dt", { children: "Status" }, []),
                jsxRuntime.jsxs("dd", { children: state.running ? "running agent" : "idle" }, []),
                jsxRuntime.jsxs("dt", { children: "Source" }, []),
                jsxRuntime.jsxs("dd", { children: state.sourceTag || "client" }, [])
              ] }, []),
              jsxRuntime.jsxs("p", { className: "sdsh-warning", children: [
                "This permanently deletes the session's durable log, projection cache, and workspace accounting. ",
                "There is no undo."
              ] }),
              jsxRuntime.jsx("label", { className: "sdsh-ack", children: [
                jsxRuntime.jsx("input", {
                  type: "checkbox",
                  checked: state.acknowledged,
                  disabled: state.busy,
                  onChange: function(e) {
                    setAcknowledged(e.target.checked);
                  }
                }),
                " I understand this permanently deletes the session."
              ] }),
              state.running ? jsxRuntime.jsx("label", { className: "sdsh-ack sdsh-ack-warn", children: [
                jsxRuntime.jsx("input", {
                  type: "checkbox",
                  checked: state.interruptAcknowledged,
                  disabled: state.busy || !state.acknowledged,
                  onChange: function(e) {
                    setInterruptAcknowledged(e.target.checked);
                  }
                }),
                " I acknowledge this cancels the running agent."
              ] }) : null,
              state.error ? jsxRuntime.jsx("p", { className: "sdsh-error", role: "alert", children: state.error }) : null,
              jsxRuntime.jsxs("div", { className: "sdsh-actions", children: [
                jsxRuntime.jsx("button", {
                  type: "button",
                  className: "sdsh-cancel",
                  onClick: closeDialog,
                  disabled: state.busy,
                  children: "Cancel"
                }),
                jsxRuntime.jsx("button", {
                  type: "button",
                  className: "sdsh-confirm",
                  onClick: function() {
                    confirmFromDialog(seam);
                  },
                  disabled: !canConfirm,
                  "aria-disabled": !canConfirm,
                  children: state.busy ? "Deleting\u2026" : "Delete Permanently"
                })
              ] })
            ]
          }, [])
        });
      }
      function openFromTarget(sourceTag, sessionId, seam) {
        if (!seam || typeof seam.describeSession !== "function") {
          openDialog(sessionId, sourceTag, { title: sessionId, running: false });
          return;
        }
        Promise.resolve().then(function() {
          return seam.describeSession({ sessionId });
        }).then(function(info) {
          openDialog(sessionId, sourceTag, info || { title: sessionId, running: false });
        }, function() {
          openDialog(sessionId, sourceTag, { title: sessionId, running: false });
        });
      }
      function confirmFromDialog(seam) {
        if (!dialogState.sessionId) return;
        if (!seam || typeof seam.dialogConfirm !== "function") {
          setError("Deletion seam unavailable; the host plugin may have been uninstalled.");
          return;
        }
        if (!dialogState.acknowledged) return;
        if (dialogState.running && !dialogState.interruptAcknowledged) return;
        setBusy(true);
        setError(null);
        Promise.resolve().then(function() {
          return seam.dialogConfirm({
            sessionId: dialogState.sessionId,
            sourceTag: dialogState.sourceTag,
            interruptActive: dialogState.running === true
          });
        }).then(function(result) {
          if (result && result.ok) {
            closeDialog();
          } else {
            setBusy(false);
            setError(result && result.error || "Deletion failed.");
          }
        }, function(err) {
          setBusy(false);
          setError(err && err.message || "Deletion failed.");
        });
      }
      var STYLES = ".sdsh-overlay-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;z-index:10000}.sdsh-overlay-modal{background:var(--dsw-alias-bg-module-elevated,#fff);color:var(--dsw-alias-label-primary,#111);border-radius:8px;padding:24px;min-width:360px;max-width:560px;box-shadow:0 8px 32px rgba(0,0,0,.18);font-family:inherit}.sdsh-title{margin:0 0 16px;font-size:16px;font-weight:600}.sdsh-meta{display:grid;grid-template-columns:max-content 1fr;gap:6px 12px;margin:0 0 16px;font-size:13px}.sdsh-meta dt{color:var(--dsw-alias-label-tertiary,#777)}.sdsh-meta dd{margin:0;word-break:break-all}.sdsh-meta-sub{color:var(--dsw-alias-label-tertiary,#777)}.sdsh-warning{margin:0 0 16px;padding:12px;background:var(--dsw-alias-bg-warning-soft,#fff7e6);border-radius:6px;font-size:13px}.sdsh-ack{display:flex;align-items:center;gap:8px;margin:8px 0;font-size:13px;cursor:pointer}.sdsh-ack-warn{color:var(--dsw-alias-label-warn,#a00)}.sdsh-ack input{margin:0}.sdsh-error{margin:0 0 16px;padding:10px;background:var(--dsw-alias-bg-error-soft,#fee);color:var(--dsw-alias-label-error,#900);border-radius:6px;font-size:13px}.sdsh-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:16px}.sdsh-actions button{padding:8px 14px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1,#ccc);background:transparent;color:inherit;font:inherit}.sdsh-actions button.sdsh-cancel:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,#eee)}.sdsh-actions button.sdsh-confirm{background:var(--dsw-alias-bg-error,#a00);color:#fff;border-color:transparent}.sdsh-actions button.sdsh-confirm:disabled{opacity:.5;cursor:not-allowed}.sdsh-actions button.sdsh-confirm:not(:disabled):hover{background:var(--dsw-alias-bg-error-hover,#800)}.sdsh-header-button{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:6px;border-radius:6px;border:none;background:transparent;color:var(--dsw-alias-label-tertiary,#777);cursor:pointer}.sdsh-header-button:hover{background:var(--dsw-alias-interactive-bg-hover,#f3f3f3);color:var(--dsw-alias-label-error,#a00)}.sdsh-header-button .sdsh-icon{font-size:14px;line-height:1}.sdsh-menu-item{display:block;width:100%;text-align:left;padding:8px 12px;background:transparent;border:none;color:inherit;cursor:pointer;font:inherit}.sdsh-menu-item:hover{background:var(--dsw-alias-interactive-bg-hover,#f3f3f3);color:var(--dsw-alias-label-error,#a00)}";
      function ensureStylesInjected() {
        if (typeof document === "undefined") return;
        if (document.querySelector('style[data-plugin-sdsh="1"]')) return;
        var style = document.createElement("style");
        style.setAttribute("data-plugin-sdsh", "1");
        style.textContent = STYLES;
        document.head.appendChild(style);
      }
      function apply(ctx) {
        if (!ctx || !ctx.slots) return;
        ensureStylesInjected();
        var seam = ctx.safeSessionDelete;
        function mount(name, opts, component) {
          ctx.slots.inject(name, function() {
            return ctx.slots.register(Object.assign({ name }, opts), component);
          });
        }
        mount("conversation.session.header.actions", {
          id: "safe-session-delete-header",
          order: 900,
          registrant: "dsh-plugin-safe-session-delete",
          inject: function(sessionId) {
            return { sessionId: String(sessionId || ""), seam };
          }
        }, HeaderButton);
        mount("sidebar.workspaces.session.menu.item", {
          id: "safe-session-delete-sidebar",
          order: 950,
          registrant: "dsh-plugin-safe-session-delete",
          inject: function(sessionId) {
            return { sessionId: String(sessionId || ""), seam };
          }
        }, SidebarItem);
        mount("shell.overlay", {
          id: "safe-session-delete-dialog",
          priority: 100,
          registrant: "dsh-plugin-safe-session-delete",
          inject: function() {
            return { seam };
          }
        }, DeleteDialog);
      }
      exports.name = "dsh-plugin-safe-session-delete";
      exports.apply = apply;
      return module.exports;
    }
  });
})();
