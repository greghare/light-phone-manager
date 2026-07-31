"use strict";

const { execFile } = require("child_process");
const ffmpegPath = require("@ffmpeg-installer/ffmpeg").path;

// Transcodes any audio file ffmpeg can read into an AAC-in-MP4 (.m4a) file —
// the format the Light Phone 3's stock Ringtones/Alerts expect. `-vn` drops
// any embedded cover art some formats (mp3, flac) carry as a video stream,
// which would otherwise make ffmpeg try (and fail) to mux it into the m4a.
function convertToM4a(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    execFile(
      ffmpegPath,
      ["-y", "-i", inputPath, "-vn", "-c:a", "aac", "-b:a", "192k", outputPath],
      { timeout: 60000 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(stderr?.trim() || err.message));
        resolve(outputPath);
      }
    );
  });
}

module.exports = { convertToM4a };
