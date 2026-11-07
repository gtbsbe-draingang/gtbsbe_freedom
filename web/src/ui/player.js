// The call player (extra 7, R6): the recording on top of a call's transcript, linked to its lines.
//
//   renderPlayer(conversation, api, transcript) -> { el, seek(index), destroy } | null
//     null for a chat. `transcript` is what the pane lends the player:
//       markPlaying(index | null, {follow})  marks the line being played (.is-playing); `follow`
//                                            while it plays, so the pane can keep it in view
//       openImport()                         opens the loader on this call's group
//     With a recording (api.audioUrl): custom speaker waveforms over a hidden audio engine. `timeupdate` and
//     `seeked` mark the line whose start ≤ currentTime < the next start; seek(index) moves the
//     recording to the start of that line (a line's time and an evidence link call it) and is false
//     when the line has no start. Without one: `audio_unavailable_reason` "needs_import" says
//     «Загрузите группу, чтобы включить запись» with a button that opens the loader.
//     destroy() pauses the recording: a detached <audio> keeps playing otherwise.
//
//   startTimes(conversation) -> (number | null)[]   each line's start in the recording, in seconds:
//     `audio_offsets` (the calibrated starts), or, when there are none, the transcript's own times
//     on the recording's clock (recordingOffsets: from "recording started", paused stretches cut)
//   playingIndex(starts, seconds) -> number | null   the line being played at that time
import { formatOffset, recordingOffsets } from "../domain/time.js";
import { speakerWindows, splitWaveform } from "../domain/waveform.js";
import { t } from "../i18n/ru.js";
import { h, svg } from "./dom.js";

const isTime = (value) => typeof value === "number" && Number.isFinite(value);

export function startTimes(conversation) {
  const transcript = Array.isArray(conversation?.transcript) ? conversation.transcript : [];
  const given = Array.isArray(conversation?.audio_offsets) ? conversation.audio_offsets : [];
  if (given.length === 0) return recordingOffsets(transcript).map((value) => (isTime(value) ? value : null));
  const starts = transcript.map(() => null);
  for (const entry of given) {
    const index = entry?.message_index;
    if (Number.isInteger(index) && index >= 0 && index < starts.length && isTime(entry.seconds)) starts[index] = entry.seconds;
  }
  return starts;
}

export function playingIndex(starts, seconds) {
  if (!isTime(seconds)) return null;
  let best = null;
  for (let i = 0; i < starts.length; i += 1) {
    const start = starts[i];
    if (!isTime(start) || start > seconds) continue;
    if (best === null || start >= starts[best]) best = i; // equal starts: the later line wins
  }
  return best;
}

export function renderPlayer(conversation, api, transcript) {
  if (conversation?.channel !== "voice call") return null;
  const src = api.audioUrl(conversation);

  if (!src) {
    const needsImport = conversation.audio_unavailable_reason === "needs_import";
    const el = h(
      "div",
      { class: ["cqa-player", "cqa-player--none"], data: { test: "player" } },
      h("p", { class: "cqa-player-note", text: t(needsImport ? "player.needsImport" : "player.none") }),
      needsImport
        ? h("button", { class: "cqa-sc-btn", attrs: { type: "button" }, text: t("player.import"), data: { test: "player-import" }, on: { click: () => transcript.openImport?.() } })
        : null,
    );
    return { el, seek: () => false, destroy() {} };
  }

  const starts = startTimes(conversation);
  const status = h("p", { class: "cqa-player-note", attrs: { role: "status" } });
  status.hidden = true;
  const audio = h("audio", { class: "cqa-player-audio", attrs: { preload: "metadata", src, "aria-label": t("player.label") } });
  const playIcon = svg("svg", { viewBox: "0 0 24 24", width: 22, height: 22, "aria-hidden": "true" });
  const play = h("button", { class: "cqa-wave-play", attrs: { type: "button", "aria-label": t("player.play") }, data: { test: "player-play" } }, playIcon);
  const clock = h("span", { class: "cqa-wave-clock num", text: "0:00 / —", data: { test: "player-time" } });
  const scrubber = h("input", { class: "cqa-wave-range", attrs: { type: "range", min: 0, max: 1, step: 0.1, value: 0, disabled: true, "aria-label": t("player.timeline") }, data: { test: "player-seek" } });
  const mute = h("button", { class: "cqa-wave-mute", attrs: { type: "button", "aria-label": t("player.mute"), "aria-pressed": "false" }, data: { test: "player-mute" } });
  const speed = h("select", { class: "cqa-wave-speed", attrs: { "aria-label": t("player.speed") }, data: { test: "player-speed" } },
    [0.75, 1, 1.25, 1.5, 2].map((value) => h("option", { attrs: { value }, text: `${value}×` })));
  speed.value = "1";
  const waveformNote = h("span", { text: t("player.waveformLoading"), attrs: { role: "status" }, data: { test: "waveform-status" } });
  const tracks = ["client", "operator"].map((role) => {
    const graphic = svg("svg", { viewBox: "0 0 660 48", preserveAspectRatio: "none", "aria-hidden": "true", focusable: "false" });
    const selection = h("span", { class: "cqa-wave-selection" });
    const cursor = h("span", { class: "cqa-wave-cursor" });
    const plot = h("div", { class: ["cqa-wave-plot", `cqa-wave-plot--${role}`], attrs: { role: "slider", tabindex: 0, "aria-label": `${t(`player.${role}`)} — ${t("player.timeline")}`, "aria-valuemin": 0, "aria-valuemax": 0, "aria-valuenow": 0 }, data: { test: "waveform-track", speaker: role } }, selection, graphic, cursor);
    return { role, plot, graphic, selection, cursor, bars: [] };
  });
  const el = h("div", { class: ["cqa-player", "cqa-wave-player"], data: { test: "player" } }, audio,
    h("div", { class: "cqa-wave-tracks" }, tracks.map(({ role, plot }) => h("div", { class: "cqa-wave-row" }, h("b", { class: "cqa-wave-label", text: t(`player.${role}`) }), plot))),
    h("div", { class: "cqa-wave-controls" }, play, clock, scrubber, mute, speed),
    h("div", { class: "cqa-wave-caption" }, h("span", { text: t("player.speakerNote"), attrs: { title: t("player.speakerTitle") } }), waveformNote), status);
  let current = null;
  let destroyed = false;
  let envelope = null;
  let windows = [];
  let frame = null;
  let waveRun = 0;
  const controller = new AbortController();
  const duration = () => isTime(audio.duration) && audio.duration > 0 ? audio.duration : (envelope?.duration ?? 0);

  function paintControls() {
    playIcon.replaceChildren(svg("path", { d: audio.paused ? "M8 5v14l11-7Z" : "M6 5h4v14H6zM14 5h4v14h-4z", fill: "currentColor" }));
    play.setAttribute("aria-label", t(audio.paused ? "player.play" : "player.pause"));
    mute.replaceChildren(svg("svg", { viewBox: "0 0 24 24", width: 18, height: 18, fill: "none", stroke: "currentColor", "stroke-width": 1.8, "stroke-linecap": "round", "aria-hidden": "true" },
      svg("path", { d: "M11 4 5 9H2v6h3l6 5Z" }), svg("path", { d: audio.muted ? "m16 9 6 6m0-6-6 6" : "M15 8a6 6 0 0 1 0 8M18 5a10 10 0 0 1 0 14" })));
    mute.setAttribute("aria-label", t(audio.muted ? "player.unmute" : "player.mute"));
    mute.setAttribute("aria-pressed", String(audio.muted));
  }

  function paintProgress() {
    const length = duration();
    const seconds = audio.currentTime || 0;
    const fraction = length ? Math.min(1, seconds / length) : 0;
    clock.textContent = `${formatOffset(seconds) || "0:00"} / ${length ? formatOffset(length) : "—"}`;
    scrubber.disabled = !length;
    scrubber.max = String(length || 1);
    scrubber.value = String(seconds);
    scrubber.style.setProperty("--progress", `${fraction * 100}%`);
    scrubber.setAttribute("aria-valuetext", clock.textContent);
    const window = windows.find((part) => seconds >= part.from && seconds < part.to);
    for (const track of tracks) {
      track.plot.setAttribute("aria-valuemax", String(length));
      track.plot.setAttribute("aria-valuenow", String(seconds));
      track.plot.setAttribute("aria-valuetext", clock.textContent);
      track.cursor.style.left = `${fraction * 100}%`;
      track.selection.hidden = !window || window.role !== track.role;
      if (window) {
        track.selection.style.left = `${window.from / length * 100}%`;
        track.selection.style.width = `${(window.to - window.from) / length * 100}%`;
      }
      track.bars.forEach((bar, index) => bar.classList.toggle("is-played", index / track.bars.length < fraction));
    }
  }

  function drawWaves() {
    if (destroyed) return;
    const length = duration();
    windows = speakerWindows(conversation.transcript ?? [], starts, length);
    for (const track of tracks) {
      const peaks = envelope ? splitWaveform(envelope.peaks, windows, length, track.role) : [];
      track.bars = peaks.map((peak, index) => svg("rect", { class: "cqa-wave-bar", x: index * 3, y: 24 - Math.max(1, peak * 20), width: 1.8, height: Math.max(2, peak * 40), rx: 0.9 }));
      track.graphic.replaceChildren(...track.bars);
    }
    paintProgress();
  }

  async function loadWaveform() {
    const mine = ++waveRun;
    waveformNote.textContent = t("player.waveformLoading");
    try {
      const data = await api.getAudioWaveform(src, { signal: controller.signal });
      if (destroyed || mine !== waveRun) return;
      envelope = data;
      waveformNote.textContent = "";
      el.setAttribute("data-waveform", "ready");
      drawWaves();
    } catch {
      if (destroyed || mine !== waveRun) return;
      waveformNote.textContent = t("player.waveformUnavailable");
      el.setAttribute("data-waveform", "unavailable");
    }
  }

  function animate() {
    if (destroyed || audio.paused) { frame = null; return; }
    paintProgress();
    frame = requestAnimationFrame(animate);
  }

  function seekSeconds(seconds) {
    if (destroyed || !isTime(seconds) || seconds < 0) return false;
    audio.currentTime = duration() ? Math.min(seconds, duration()) : seconds;
    mark();
    return true;
  }

  play.addEventListener("click", async () => {
    if (!audio.paused) { audio.pause(); return; }
    try { await audio.play(); }
    catch { if (!destroyed) { status.textContent = t("player.failed"); status.hidden = false; } }
  });
  mute.addEventListener("click", () => { audio.muted = !audio.muted; });
  speed.addEventListener("change", () => { audio.playbackRate = Number(speed.value); });
  scrubber.addEventListener("input", () => seekSeconds(Number(scrubber.value)));
  for (const track of tracks) {
    const seekPointer = (event) => {
      const bounds = track.plot.getBoundingClientRect();
      if (bounds.width) seekSeconds(Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)) * duration());
    };
    track.plot.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || !duration()) return;
      track.plot.focus();
      track.plot.setPointerCapture(event.pointerId);
      seekPointer(event);
    });
    track.plot.addEventListener("pointermove", (event) => { if (track.plot.hasPointerCapture(event.pointerId)) seekPointer(event); });
    track.plot.addEventListener("pointerup", (event) => { if (track.plot.hasPointerCapture(event.pointerId)) track.plot.releasePointerCapture(event.pointerId); });
    track.plot.addEventListener("keydown", (event) => {
      const next = { ArrowLeft: audio.currentTime - 5, ArrowDown: audio.currentTime - 5, ArrowRight: audio.currentTime + 5, ArrowUp: audio.currentTime + 5, Home: 0, End: duration() }[event.key];
      if (next === undefined) return;
      event.preventDefault();
      seekSeconds(Math.max(0, next));
    });
  }

  function mark() {
    paintProgress();
    const index = playingIndex(starts, audio.currentTime);
    if (index === current) return;
    current = index;
    transcript.markPlaying(index, { follow: !audio.paused });
  }

  audio.addEventListener("timeupdate", mark);
  audio.addEventListener("seeked", mark);
  audio.addEventListener("loadedmetadata", () => {
    status.hidden = true;
    drawWaves();
  });
  audio.addEventListener("durationchange", drawWaves);
  audio.addEventListener("play", () => { paintControls(); if (frame === null) animate(); });
  audio.addEventListener("pause", () => { paintControls(); if (frame !== null) cancelAnimationFrame(frame); frame = null; paintProgress(); });
  audio.addEventListener("ended", () => { paintControls(); paintProgress(); });
  audio.addEventListener("volumechange", paintControls);
  audio.addEventListener("error", () => {
    if (destroyed) return;
    status.replaceChildren(
      t("player.failed"),
      " ",
      h("button", { class: ["cqa-link", "cqa-player-retry"], attrs: { type: "button" }, text: t("player.retry"), data: { test: "player-retry" }, on: { click: () => { audio.load(); loadWaveform(); } } }),
    );
    status.hidden = false;
  });

  paintControls();
  loadWaveform();
  return {
    el,
    seek(index) { return seekSeconds(starts[index]); },
    seekSeconds,
    destroy() {
      destroyed = true;
      controller.abort();
      if (frame !== null) cancelAnimationFrame(frame);
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
    },
  };
}
