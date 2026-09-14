/** 按 APP 规则仅从文件名补充身份，保留现场、翻唱与混音版本。 */
export function musicFileNameHints(fileName: string, title: string, artist: string) {
  const clean = (value: string) => value.replace(/[\[【（(]\s*(?:无损|高音质|高品质|FLAC|MP3|APE|WAV|SQ|HQ|Hi-Res|\d{2,4}\s*kbps|\d{2,3}\s*bit(?:\s*[-/]\s*\d+(?:\.\d+)?\s*kHz)?)\s*[\]】）)]/giu, "").replace(/_/gu, " ").replace(/\s+/gu, " ").trim();
  const rawStem = fileName.replace(/\.[^.]+$/u, "");
  const position = rawStem.match(/^\s*(\d{1,3})\s*[._-]\s*/u);
  const stem = clean(position ? rawStem.slice(position[0].length) : rawStem);
  const spaced = /\s+[-–—]\s+/u.exec(stem);
  const index = spaced?.index ?? Math.max(stem.lastIndexOf("-"), stem.lastIndexOf("–"), stem.lastIndexOf("—"));
  const same = (left: string, right: string) => clean(left).toLowerCase() === clean(right).toLowerCase();
  let guessedTitle = stem;
  let guessedArtist = "";
  if (index > 0) {
    const first = stem.slice(0, index).trim();
    const second = stem.slice(index + (spaced?.[0].length ?? 1)).trim();
    if (second && ((title && same(title, first)) || (artist && same(artist, second)))) { guessedTitle = first; guessedArtist = second; }
    else if (second && ((!title && !artist) || (title && same(title, second)) || (artist && same(artist, first)))) { guessedTitle = second; guessedArtist = first; }
  }
  return { title: title || guessedTitle || rawStem, artist: artist || guessedArtist, trackNumber: position ? Number(position[1]) : 0 };
}
