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

const SUIT_FILE_NAMES = { S: "spade", H: "heart", D: "diamond", C: "club" };
const RANK_FILE_NAMES = { A: "1", J: "jack", Q: "queen", K: "king" };

function cardImagePath(card) {
  const suitName = SUIT_FILE_NAMES[card.suit];
  const rankName = RANK_FILE_NAMES[card.rank] || card.rank;
  return `assets/cards/${suitName}_${rankName}.png`;
}

const cardImages = {};
function preloadCardImages() {
  ALL_CARDS.forEach((card) => {
    const img = new Image();
    img.src = cardImagePath(card);
    cardImages[`${card.suit}${card.rank}`] = img;
  });
}
preloadCardImages();

function getCardImage(card) {
  const img = cardImages[`${card.suit}${card.rank}`];
  if (img.complete && img.naturalWidth > 0) return Promise.resolve(img);
  return new Promise((resolve) => img.addEventListener("load", () => resolve(img), { once: true }));
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

/* ---------- PICK SCREEN ---------- */

function renderPickGrid() {
  const grid = document.getElementById("pickGrid");
  grid.innerHTML = "";
  ALL_CARDS.forEach((card) => {
    const tile = document.createElement("div");
    tile.className = "card-tile";
    tile.innerHTML = `<img src="${cardImagePath(card)}" alt="${card.rank} of ${findSuit(card.suit).symbol}">`;
    tile.addEventListener("click", () => revealCard(card));
    grid.appendChild(tile);
  });
}

async function revealCard(card) {
  const img = await getCardImage(card);

  const canvas = document.getElementById("workCanvas");
  canvas.width = capturedPhotoCanvas.width;
  canvas.height = capturedPhotoCanvas.height;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(capturedPhotoCanvas, 0, 0);
  ctx.drawImage(img, guideRectNative.x, guideRectNative.y, guideRectNative.width, guideRectNative.height);

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
