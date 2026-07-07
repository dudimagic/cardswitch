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
let detectedQuad = null;

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
  runCardDetection();
  renderPickGrid();
  showScreen("pick");
}

document.getElementById("shutterBtn").addEventListener("click", takePhoto);

/* ---------- CARD DETECTION (OpenCV.js) ---------- */

function fallbackQuadFromGuideRect() {
  const r = guideRectNative;
  return [
    { x: r.x, y: r.y },
    { x: r.x + r.width, y: r.y },
    { x: r.x + r.width, y: r.y + r.height },
    { x: r.x, y: r.y + r.height },
  ];
}

function orderQuadPoints(pts) {
  const sums = pts.map((p) => p.x + p.y);
  const diffs = pts.map((p) => p.y - p.x);
  const topLeft = pts[sums.indexOf(Math.min(...sums))];
  const bottomRight = pts[sums.indexOf(Math.max(...sums))];
  const topRight = pts[diffs.indexOf(Math.min(...diffs))];
  const bottomLeft = pts[diffs.indexOf(Math.max(...diffs))];
  return [topLeft, topRight, bottomRight, bottomLeft];
}

function detectCardQuad(canvas) {
  const src = cv.imread(canvas);
  const gray = new cv.Mat();
  const blurred = new cv.Mat();
  const edges = new cv.Mat();
  const dilated = new cv.Mat();
  const kernel = cv.Mat.ones(3, 3, cv.CV_8U);
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  let best = null;

  try {
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0);
    cv.Canny(blurred, edges, 50, 150);
    cv.dilate(edges, dilated, kernel);
    cv.findContours(dilated, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);

    const minArea = canvas.width * canvas.height * 0.03;
    let bestArea = 0;

    for (let i = 0; i < contours.size(); i++) {
      const cnt = contours.get(i);
      const peri = cv.arcLength(cnt, true);
      const approx = new cv.Mat();
      cv.approxPolyDP(cnt, approx, 0.02 * peri, true);
      if (approx.rows === 4) {
        const area = Math.abs(cv.contourArea(approx));
        if (area > bestArea && area > minArea) {
          bestArea = area;
          if (best) best.delete();
          best = approx.clone();
        }
      }
      approx.delete();
      cnt.delete();
    }

    if (!best) return null;

    const pts = [];
    for (let i = 0; i < 4; i++) {
      pts.push({ x: best.intPtr(i, 0)[0], y: best.intPtr(i, 0)[1] });
    }
    return orderQuadPoints(pts);
  } finally {
    src.delete();
    gray.delete();
    blurred.delete();
    edges.delete();
    dilated.delete();
    kernel.delete();
    contours.delete();
    hierarchy.delete();
    if (best) best.delete();
  }
}

function detectSkinMask(canvas) {
  const src = cv.imread(canvas);
  const rgb = new cv.Mat();
  const ycrcb = new cv.Mat();
  const low = new cv.Mat(src.rows, src.cols, cv.CV_8UC3, [0, 135, 85, 0]);
  const high = new cv.Mat(src.rows, src.cols, cv.CV_8UC3, [255, 180, 135, 0]);
  const mask = new cv.Mat();
  const kernel = cv.Mat.ones(5, 5, cv.CV_8U);

  try {
    cv.cvtColor(src, rgb, cv.COLOR_RGBA2RGB);
    cv.cvtColor(rgb, ycrcb, cv.COLOR_RGB2YCrCb);
    cv.inRange(ycrcb, low, high, mask);
    cv.morphologyEx(mask, mask, cv.MORPH_OPEN, kernel);
    cv.morphologyEx(mask, mask, cv.MORPH_CLOSE, kernel);
    cv.GaussianBlur(mask, mask, new cv.Size(9, 9), 0);
    return mask.clone();
  } finally {
    src.delete();
    rgb.delete();
    ycrcb.delete();
    low.delete();
    high.delete();
    kernel.delete();
    mask.delete();
  }
}

function setDetectStatus(text) {
  const el = document.getElementById("detectStatus");
  if (el) el.textContent = text;
}

function runCardDetection() {
  if (!window.cvReady) {
    detectedQuad = fallbackQuadFromGuideRect();
    setDetectStatus("Vision engine still loading — using guide box for this shot.");
    return;
  }
  try {
    const quad = detectCardQuad(capturedPhotoCanvas);
    if (quad) {
      detectedQuad = quad;
      setDetectStatus("Card detected.");
    } else {
      detectedQuad = fallbackQuadFromGuideRect();
      setDetectStatus("Card outline not found — using guide box instead.");
    }
  } catch (err) {
    detectedQuad = fallbackQuadFromGuideRect();
    setDetectStatus("Detection error — using guide box instead.");
  }
}

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

  let usedFallback = false;
  if (window.cvReady) {
    try {
      compositeWithOpenCv(canvas, img);
    } catch (err) {
      usedFallback = true;
    }
  } else {
    usedFallback = true;
  }

  if (usedFallback) {
    compositeSimplePaste(canvas, img);
  }

  document.getElementById("resultImage").src = canvas.toDataURL("image/jpeg", 0.92);
  document.getElementById("saveConfirm").classList.add("hidden");
  showScreen("gallery");
}

function compositeSimplePaste(canvas, img) {
  const ctx = canvas.getContext("2d");
  ctx.drawImage(capturedPhotoCanvas, 0, 0);
  ctx.drawImage(img, guideRectNative.x, guideRectNative.y, guideRectNative.width, guideRectNative.height);
}

function compositeWithOpenCv(canvas, img) {
  const quad = detectedQuad || fallbackQuadFromGuideRect();

  const cardCanvas = document.createElement("canvas");
  cardCanvas.width = img.naturalWidth;
  cardCanvas.height = img.naturalHeight;
  cardCanvas.getContext("2d").drawImage(img, 0, 0);

  const photoMat = cv.imread(capturedPhotoCanvas);
  const cardMat = cv.imread(cardCanvas);
  const srcPts = cv.matFromArray(4, 1, cv.CV_32FC2, [
    0, 0,
    cardMat.cols, 0,
    cardMat.cols, cardMat.rows,
    0, cardMat.rows,
  ]);
  const dstPts = cv.matFromArray(4, 1, cv.CV_32FC2, [
    quad[0].x, quad[0].y,
    quad[1].x, quad[1].y,
    quad[2].x, quad[2].y,
    quad[3].x, quad[3].y,
  ]);
  const M = cv.getPerspectiveTransform(srcPts, dstPts);
  const warped = new cv.Mat();
  const quadMask = cv.Mat.zeros(photoMat.rows, photoMat.cols, cv.CV_8UC1);
  const quadPtsInt = cv.matFromArray(4, 1, cv.CV_32SC2, [
    quad[0].x, quad[0].y,
    quad[1].x, quad[1].y,
    quad[2].x, quad[2].y,
    quad[3].x, quad[3].y,
  ]);
  const quadVec = new cv.MatVector();
  let skinMask = null;
  let notSkin = null;
  let finalMask = null;

  try {
    cv.warpPerspective(cardMat, warped, M, new cv.Size(photoMat.cols, photoMat.rows));
    quadVec.push_back(quadPtsInt);
    cv.fillPoly(quadMask, quadVec, new cv.Scalar(255));

    skinMask = detectSkinMask(capturedPhotoCanvas);
    notSkin = new cv.Mat();
    cv.bitwise_not(skinMask, notSkin);
    finalMask = new cv.Mat();
    cv.bitwise_and(quadMask, notSkin, finalMask);

    warped.copyTo(photoMat, finalMask);
    cv.imshow(canvas, photoMat);
  } finally {
    photoMat.delete();
    cardMat.delete();
    srcPts.delete();
    dstPts.delete();
    M.delete();
    warped.delete();
    quadMask.delete();
    quadPtsInt.delete();
    quadVec.delete();
    if (skinMask) skinMask.delete();
    if (notSkin) notSkin.delete();
    if (finalMask) finalMask.delete();
  }
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
