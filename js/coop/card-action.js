/** Bind the action to the displayed peer, including Room and direct native video. */
export function toggleCoopCardControl(controller, peerId, connection) {
  if (!controller || !connection?.open || connection.peer !== peerId) return;
  const state = controller.getCoopState();
  if (state.isPlayer2 && state.activeHostPeerId === peerId) {
    controller.releaseCoopControl();
    return;
  }
  if (state.isPlayer2) controller.releaseCoopControl();
  controller.requestCoopControl(peerId, connection);
}
