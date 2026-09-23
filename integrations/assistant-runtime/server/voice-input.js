import { enabled } from './features.js';

/** One microphone policy for local capture and both glasses companions. */
export function voiceInputIssue(config, inputDevice) {
  if (!config || !enabled(config, 'voice') || config.voice?.enabled !== true) return 'Voice input is switched off.';
  if (config.stt?.enabled !== true) return 'Speech recognition is switched off.';
  if (inputDevice === 'even-glasses' && !enabled(config, 'even-realities')) return 'Even glasses are switched off.';
  if (config.voice.inputMuted) return 'Microphone is muted.';
  if (config.voice.inputDevice && config.voice.inputDevice !== inputDevice) return 'Another microphone is selected.';
  return '';
}

/** Settings can change while a provider is transcribing; never act on revoked audio. */
export async function transcribeVoiceInput({ getConfig, transcriber, pcm, inputDevice, isCurrent = () => true, signal }) {
  const issue = () => voiceInputIssue(getConfig(), inputDevice) || (!isCurrent() ? 'Microphone changed during transcription.' : '');
  let reason = issue();
  if (reason) return { ignored: true, reason };
  signal?.throwIfAborted();
  const heard = await transcriber.transcribe(pcm, { signal });
  reason = issue();
  if (reason) return { ignored: true, reason };
  signal?.throwIfAborted();
  return heard;
}
