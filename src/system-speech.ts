//! Read Aloud's system speech backend.
//!
//! Linux's WebKitGTK has no `speechSynthesis` (Ubuntu builds it without the Web
//! Speech synthesis backend), so this wrapper drives the Rust `spd-say` bridge
//! instead. `src/read-aloud.ts` stays platform-neutral: it receives a
//! `SpeechBackend` and a `VoiceSource`, and the queue's own state machine still
//! owns sentence advancement and Stop.
//!
//! A generation counter makes a late answer from a cancelled sentence harmless,
//! and `stopping` makes a new sentence wait for Stop to reach Rust, so a fast
//! Start after Stop cannot cancel the new one.

import { speechSpeak, speechStatus, speechStop, type SpeechVoice as ApiSpeechVoice } from "./api";
import type {
  SpeakEvents,
  SpeakOptions,
  SpeechBackend,
  VoiceOption,
  VoiceSource,
} from "./read-aloud.ts";

/** True when the webview has no Web Speech API but the app is on Linux. */
export function needsSystemSpeech(userAgent: string): boolean {
  if (typeof window === "undefined" || "speechSynthesis" in window) return false;
  return /Linux/i.test(userAgent);
}

function toOption(voice: ApiSpeechVoice): VoiceOption {
  return {
    name: voice.name,
    lang: voice.lang,
    local: voice.local,
    isDefault: voice.isDefault,
  };
}

function messageOf(error: unknown): string {
  const text = String(error ?? "").trim();
  return text || "speech-dispatcher could not speak the text.";
}

export interface SystemSpeech {
  backend: SpeechBackend;
  voiceSource: VoiceSource;
}

export function createSystemSpeech(): SystemSpeech {
  let voices: VoiceOption[] = [];
  let reason: string | null = null;
  let loaded = false;
  let pending: Promise<VoiceOption[]> | null = null;

  const load = async (): Promise<VoiceOption[]> => {
    const status = await speechStatus();
    voices = status.voices.map(toOption);
    reason = status.available
      ? null
      : (status.reason ?? "The system speech service is unavailable.");
    loaded = true;
    return voices;
  };

  const voiceSource: VoiceSource = {
    read: () => voices,
    refresh: () => {
      if (!pending) {
        pending = load().finally(() => {
          pending = null;
        });
      }
      return pending;
    },
    reason: () => (loaded ? reason : null),
  };

  // A cancelled sentence's promise may settle after the next one has started;
  // only the current generation may reach the queue.
  let generation = 0;
  let stopping: Promise<void> | null = null;

  const backend: SpeechBackend = {
    speak(text: string, options: SpeakOptions, events: SpeakEvents) {
      const mine = ++generation;
      events.onStart();
      const gate = stopping ?? Promise.resolve();
      void gate
        .then(() => speechSpeak(text, options.lang, options.voiceName, options.rate))
        .then(() => {
          if (mine === generation) events.onEnd();
        })
        .catch((error: unknown) => {
          if (mine === generation) events.onError(messageOf(error));
        });
    },
    cancel() {
      generation += 1;
      const task = speechStop().catch(() => undefined);
      stopping = task;
      void task.finally(() => {
        if (stopping === task) stopping = null;
      });
    },
  };

  return { backend, voiceSource };
}
