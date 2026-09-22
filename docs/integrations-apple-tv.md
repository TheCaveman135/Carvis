# TV AI Controller integration

This integration connects Carvis to an **existing TV AI Controller Home Assistant add-on**. It is an adapter, not the visual controller itself. The controller add-on must implement the API below and already have its own capture/remote/model configuration. No personal TV configuration is shipped with Carvis.

1. Complete Carvis home setup. The shared connection is managed in **Settings → Home Assistant**.
2. Select the TV media-player in Home Assistant. Control requires the controllable list; status only requires observation. A remote can be the selected target when no media-player is configured.
3. Enable TV AI Controller. Enter the actual entity IDs and add-on slug. The slug defaults to `local_apple_tv_ai`.
4. Under **Context**, optionally enter streaming-app or subtitle preferences. Under **Reply behavior**, choose **Silent successful navigation** and **Short power and playback replies**, which save automatically. Both switches default to on.
5. Test the connection. HA's token must permit Supervisor API access. This requires a Home Assistant installation with Supervisor and the running controller add-on.

All actions go through the controller. Navigation never falls back to direct Home Assistant services. The Home Assistant dry-run setting and per-entity guards still apply. Every action is a direct owner request; guarded targets ask for confirmation. A configured remote ID is needed for navigation transport, but it does not have to be exposed to Carvis when the selected TV media-player supplies permission. The selected target’s guard controls confirmation; choose its guard in **Settings → Home Assistant → Devices & permissions**.

Tools: `tv_start`, `tv_status`, `tv_context`, `tv_cancel`, `tv_button`, and `tv_command`. Starting a visual task is asynchronous. Carvis must check status before claiming it finished. `tv_context` adds guidance to the existing task at its next decision, preserving progress. For example, “Search Netflix instead” is a context update rather than a restart.

With **Advanced assistant** enabled, recognized TV navigation uses the fast command path and skips the main model loop. Successful navigation stays silent when its switch is on; power/playback commands get one short acknowledgement when theirs is on. Contextual commands such as “select” need a recent TV conversation to identify their target. Ambiguous requests can still need the model. Failures, dry runs, and required confirmations remain visible.

With only core home control enabled, TV tools still work through the normal model loop. The same switches supply response preferences, but that path can produce model narration. Enable Advanced assistant for the dedicated fast path and enforced navigation silence.

Execution details remain available even for silent commands. **TV AI Controller → Controls** provides the screen preview, live task progress, remote controls, and added context inside the main UI when Advanced assistant is enabled. Task history alone is not a live screen view; `completion_verified` is true only when the controller supplies explicit completion evidence.

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
