/** Native overlays may omit the SDK enter event. Only positive foreground
 * signals recover; never a timer that could enable a genuinely hidden app. */
export function installForegroundRecovery(host: Window, doc: Document, resume: () => void): () => void {
  const recover = () => { if (doc.visibilityState !== 'hidden') resume(); };
  host.addEventListener('focus', recover);
  host.addEventListener('pageshow', recover);
  doc.addEventListener('visibilitychange', recover);
  doc.addEventListener('pointerdown', recover);
  return () => {
    host.removeEventListener('focus', recover);
    host.removeEventListener('pageshow', recover);
    doc.removeEventListener('visibilitychange', recover);
    doc.removeEventListener('pointerdown', recover);
  };
}
