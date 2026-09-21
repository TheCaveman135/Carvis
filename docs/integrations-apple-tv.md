# Apple TV AI integration

This integration connects Carvis to an **existing Apple TV AI Home Assistant add-on**. It is an adapter, not the visual controller itself. The controller add-on must implement the API below and already have its own capture/remote/model configuration. No personal TV configuration is shipped with Carvis.

1. Enable and configure Home Assistant in Carvis.
2. Add your TV media-player and/or remote entities to the selected HA entities. Control requires the controllable list; status only requires observation.
3. Enable Apple TV AI. Enter the actual entity IDs and add-on slug. The slug defaults to `local_apple_tv_ai`.
4. Optionally enter TV context, such as preferred streaming apps or subtitle preferences.
5. Test the connection. HA's token must permit Supervisor API access. This requires a Home Assistant installation with Supervisor and the running controller add-on.

All actions go through the controller. Navigation never falls back to direct Home Assistant services. The Home Assistant dry-run setting and per-entity guards still apply. Every action is a direct owner request; guarded targets ask for confirmation. A configured remote is needed for navigation buttons. If you intend normal remote navigation without confirmation, explicitly mark that selected remote `standard` in HA guard overrides.

Tools: `tv_start`, `tv_status`, `tv_context`, `tv_cancel`, `tv_button`, and `tv_command`. Starting a visual task is asynchronous. Carvis must check status before claiming it finished. `tv_context` adds guidance to the existing task at its next decision, preserving progress. For example, “Search Netflix instead” is a context update rather than a restart.

Successful navigation requests ask Carvis to stay silent. Power/playback commands ask for one short reply. These are model response preferences, not a dedicated silent navigation path: the general chat loop may still produce a reply. The UI also shows tool execution traces. Completed task history is not a live view of the screen; `completion_verified` is true only when the controller supplies explicit completion evidence.

## Controller API contract

Carvis authenticates against HA's WebSocket API, calls `supervisor/api` with `GET /addons/{slug}/info`, and then `POST /ingress/session`. It uses the returned ingress path and cookie for controller requests. The Home Assistant token is not included in task data. Ingress access is cached for five minutes. HTTP redirects are rejected.

| Endpoint | Body / response |
| --- | --- |
| `POST /api/start` | `{goal, request_id}` → task with `id`, `status` |
| `GET /api/status` | `{run, history, model}` |
| `POST /api/context` | `{task_id, update_id, context}` → task and context revisions |
| `POST /api/stop` | `{request_id: taskId}` → task |
| `POST /api/command` | `{request_id, entity_id, service, data}` → task status `completed` |

Context is applied when `applied_context_revision >= context_revision`. A command response means the controller accepted/executed the request; it does not prove the intended screen is visible. Completed visual tasks may include `completion_check: {confirmed:true, ...}`.

Uncertain network delivery and busy responses are never automatically retried, avoiding duplicate button presses or tasks. Ask for status before retrying.
