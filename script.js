const SUITS = [
  { key: "S", symbol: "♠", color: "black" },
  { key: "H", symbol: "♥", color: "red" },
  { key: "D", symbol: "♦", color: "red" },
  { key: "C", symbol: "♣", color: "black" },
];
const RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];

const ALL_CARDS = [];
SUITS.forEach((s) => RANKS.forEach((r) => ALL_CARDS.push({ rank: r, suit: s.key })));

function findSuit(key) {
  return SUITS.find((s) => s.key === key);
}

let mediaStream = null;
let capturedPhotoCanvas = null;
let guideRectNative = null;

function showScreen(name) {
  ["menu", "camera", "pick", "gallery"].forEach((n) => {
    document.getElementById(`${n}Screen`).classList.toggle("hidden", n !== name);
  });
}

/* ---------- CAMERA ---------- */

async function startCamera() {
  const errorEl = document.getElementById("cameraError");
  errorEl.classList.add("hidden");

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    errorEl.textContent =
      "Camera isn't available. This page must be loaded over https (or localhost) for camera access to work — opening it as a plain file won't work.";
    errorEl.classList.remove("hidden");
    return;
  }

  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" } },
      audio: false,
    });
    document.getElementById("cameraVideo").srcObject = mediaStream;
  } catch (err) {
    errorEl.textContent = `Camera access failed (${err.name || "error"}). Check that camera permission is allowed for this site.`;
    errorEl.classList.remove("hidden");
  }
}

function stopCamera() {
  if (mediaStream) {
    mediaStream.getTracks().forEach((t) => t.stop());
    mediaStream = null;
  }
}

function getGuideRectInNativeVideoPixels() {
  const video = document.getElementById("cameraVideo");
  const guide = document.getElementById("guideRect");

  const videoBox = video.getBoundingClientRect();
  const guideBox = guide.getBoundingClientRect();

  const vw = video.videoWidth;
  const vh = video.videoHeight;

  // object-fit: cover mapping from displayed box back to native video pixels
  const scale = Math.max(videoBox.width / vw, videoBox.height / vh);
  const renderedW = vw * scale;
  const renderedH = vh * scale;
  const cropX = (renderedW - videoBox.width) / 2 / scale;
  const cropY = (renderedH - videoBox.height) / 2 / scale;

  const relX = guideBox.left - videoBox.left;
  const relY = guideBox.top - videoBox.top;

  return {
    x: cropX + relX / scale,
    y: cropY + relY / scale,
    width: guideBox.width / scale,
    height: guideBox.height / scale,
  };
}

function takePhoto() {
  const video = document.getElementById("cameraVideo");
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return;

  guideRectNative = getGuideRectInNativeVideoPixels();

  const canvas = document.createElement("canvas");
  canvas.width = vw;
  canvas.height = vh;
  canvas.getContext("2d").drawImage(video, 0, 0, vw, vh);
  capturedPhotoCanvas = canvas;

  stopCamera();
  renderPickGrid();
  showScreen("pick");
}

document.getElementById("shutterBtn").addEventListener("click", takePhoto);

/* ---------- CARD RENDERING ---------- */

function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawCardFace(ctx, x, y, w, h, card) {
  const suitInfo = findSuit(card.suit);
  const color = suitInfo.color === "red" ? "#e0483f" : "#1a1c22";
  const radius = w * 0.08;

  ctx.save();
  ctx.translate(x, y);

  roundRectPath(ctx, 0, 0, w, h, radius);
  ctx.fillStyle = "#fdfbf5";
  ctx.fill();
  ctx.lineWidth = Math.max(1, w * 0.012);
  ctx.strokeStyle = "rgba(0,0,0,0.2)";
  ctx.stroke();

  ctx.fillStyle = color;
  ctx.textBaseline = "top";

  const cornerPad = w * 0.09;
  const rankSize = w * 0.16;
  const suitSize = w * 0.13;

  ctx.font = `800 ${rankSize}px -apple-system, sans-serif`;
  ctx.textAlign = "left";
  ctx.fillText(card.rank, cornerPad, cornerPad * 0.7);
  ctx.font = `${suitSize}px -apple-system, sans-serif`;
  ctx.fillText(suitInfo.symbol, cornerPad, cornerPad * 0.7 + rankSize * 1.05);

  ctx.save();
  ctx.translate(w, h);
  ctx.rotate(Math.PI);
  ctx.font = `800 ${rankSize}px -apple-system, sans-serif`;
  ctx.textAlign = "left";
  ctx.fillText(card.rank, cornerPad, cornerPad * 0.7);
  ctx.font = `${suitSize}px -apple-system, sans-serif`;
  ctx.fillText(suitInfo.symbol, cornerPad, cornerPad * 0.7 + rankSize * 1.05);
  ctx.restore();

  ctx.textAlign = "center";
  const centerRankSize = w * 0.32;
  const centerSuitSize = w * 0.38;
  ctx.font = `800 ${centerRankSize}px -apple-system, sans-serif`;
  ctx.fillText(card.rank, w / 2, h * 0.22);
  ctx.font = `${centerSuitSize}px -apple-system, sans-serif`;
  ctx.fillText(suitInfo.symbol, w / 2, h * 0.46);

  ctx.restore();
}

/* ---------- PICK SCREEN ---------- */

function renderPickGrid() {
  const grid = document.getElementById("pickGrid");
  grid.innerHTML = "";
  ALL_CARDS.forEach((card) => {
    const suitInfo = findSuit(card.suit);
    const tile = document.createElement("div");
    tile.className = `card-tile ${suitInfo.color}`;
    tile.innerHTML = `<div class="rank">${card.rank}</div><div class="suit">${suitInfo.symbol}</div>`;
    tile.addEventListener("click", () => revealCard(card));
    grid.appendChild(tile);
  });
}

function revealCard(card) {
  const canvas = document.getElementById("workCanvas");
  canvas.width = capturedPhotoCanvas.width;
  canvas.height = capturedPhotoCanvas.height;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(capturedPhotoCanvas, 0, 0);
  drawCardFace(ctx, guideRectNative.x, guideRectNative.y, guideRectNative.width, guideRectNative.height, card);

  document.getElementById("resultImage").src = canvas.toDataURL("image/jpeg", 0.92);
  document.getElementById("saveConfirm").classList.add("hidden");
  showScreen("gallery");
}

/* ---------- SAVE / SHARE ---------- */

function showSaveConfirm() {
  const el = document.getElementById("saveConfirm");
  el.classList.remove("hidden");
  setTimeout(() => el.classList.add("hidden"), 2000);
}

document.getElementById("shareBtn").addEventListener("click", () => {
  const canvas = document.getElementById("workCanvas");
  canvas.toBlob(async (blob) => {
    if (!blob) return;
    const file = new File([blob], "card-switch.jpg", { type: "image/jpeg" });

    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file] });
        showSaveConfirm();
      } catch {
        // user cancelled the share sheet
      }
      return;
    }

    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "card-switch.jpg";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    showSaveConfirm();
  }, "image/jpeg", 0.92);
});

/* ---------- NAVIGATION ---------- */

document.getElementById("startTrickBtn").addEventListener("click", () => {
  showScreen("camera");
  startCamera();
});

document.getElementById("cameraBackBtn").addEventListener("click", () => {
  stopCamera();
  showScreen("menu");
});

document.getElementById("pickBackBtn").addEventListener("click", () => {
  showScreen("camera");
  startCamera();
});

document.getElementById("galleryBackBtn").addEventListener("click", () => {
  showScreen("menu");
});

document.getElementById("newTrickBtn").addEventListener("click", () => {
  showScreen("camera");
  startCamera();
});

showScreen("menu");
