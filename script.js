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
let captureMode = "trick"; // "trick" | "reference"

function showScreen(name) {
  ["menu", "camera", "pick", "gallery", "refAdjust"].forEach((n) => {
    document.getElementById(`${n}Screen`).classList.toggle("hidden", n !== name);
  });
}

function setCameraHint(text) {
  document.getElementById("cameraHint").textContent = text;
}

/* ---------- REFERENCE CARD ---------- */

const REFERENCE_KEY = "cardSwitchReferenceCard_v1";
let referenceImageEl = null;

function loadReferenceImageIntoMemory() {
  const dataUrl = localStorage.getItem(REFERENCE_KEY);
  if (!dataUrl) {
    referenceImageEl = null;
    return;
  }
  const img = new Image();
  img.src = dataUrl;
  referenceImageEl = img;
}
loadReferenceImageIntoMemory();

function updateReferenceStatus() {
  const el = document.getElementById("referenceStatus");
  const has = !!localStorage.getItem(REFERENCE_KEY);
  el.textContent = has
    ? "Reference card is set."
    : "No reference card set yet — set one before performing, or detection will fall back to the guide box.";
}
updateReferenceStatus();

// Best-effort starting guess for the reference card's four corners within
// `canvas` — Otsu-thresholds to separate the bright card from a
// comparatively darker background, then finds the bounding box of that
// region. Only used to seed the draggable corners at a reasonable
// position; the user's manual placement is what actually gets saved.
function deriveTightBoundingBox(canvas) {
  const mat = cv.imread(canvas);
  const gray = new cv.Mat();
  const binary = new cv.Mat();
  try {
    cv.cvtColor(mat, gray, cv.COLOR_RGBA2GRAY);
    cv.threshold(gray, binary, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);

    const w = binary.cols;
    const h = binary.rows;
    const data = binary.data;
    const colCount = new Array(w).fill(0);
    const rowCount = new Array(h).fill(0);
    for (let y = 0; y < h; y++) {
      const rowOffset = y * w;
      for (let x = 0; x < w; x++) {
        if (data[rowOffset + x] > 0) {
          colCount[x]++;
          rowCount[y]++;
        }
      }
    }

    const minFraction = 0.5;
    let left = 0;
    let right = w - 1;
    let top = 0;
    let bottom = h - 1;
    while (left < w && colCount[left] / h < minFraction) left++;
    while (right > left && colCount[right] / h < minFraction) right--;
    while (top < h && rowCount[top] / w < minFraction) top++;
    while (bottom > top && rowCount[bottom] / w < minFraction) bottom--;

    const boxW = right - left;
    const boxH = bottom - top;
    if (boxW < w * 0.5 || boxH < h * 0.5) return null;
    return { x: left, y: top, width: boxW, height: boxH };
  } catch (err) {
    return null;
  } finally {
    mat.delete();
    gray.delete();
    binary.delete();
  }
}

/* ---------- REFERENCE CORNER ADJUSTMENT ---------- */

// Four corners in full-photo (capturedPhotoCanvas) pixel coordinates,
// ordered top-left, top-right, bottom-right, bottom-left.
let refAdjustNative = null;
let refAdjustDragIndex = null;

function refAdjustDisplayMetrics() {
  const img = document.getElementById("refAdjustImage");
  const stage = document.getElementById("refAdjustStage");
  const imgBox = img.getBoundingClientRect();
  const stageBox = stage.getBoundingClientRect();
  const nw = img.naturalWidth;
  const nh = img.naturalHeight;
  const scale = Math.min(imgBox.width / nw, imgBox.height / nh);
  const renderedW = nw * scale;
  const renderedH = nh * scale;
  return {
    scale,
    offsetX: imgBox.left + (imgBox.width - renderedW) / 2 - stageBox.left,
    offsetY: imgBox.top + (imgBox.height - renderedH) / 2 - stageBox.top,
  };
}

function layoutRefAdjustPoints() {
  if (!refAdjustNative) return;
  const m = refAdjustDisplayMetrics();
  const screenPts = refAdjustNative.map((p) => ({
    x: m.offsetX + p.x * m.scale,
    y: m.offsetY + p.y * m.scale,
  }));
  screenPts.forEach((p, i) => {
    const dot = document.getElementById(`refDot${i}`);
    dot.style.left = `${p.x}px`;
    dot.style.top = `${p.y}px`;
  });
  const polygon = document.getElementById("refAdjustPolygon");
  polygon.setAttribute("points", screenPts.map((p) => `${p.x},${p.y}`).join(" "));
}

function showReferenceAdjustScreen() {
  const img = document.getElementById("refAdjustImage");
  img.onload = () => {
    const r = guideRectNative;
    const guessBox = window.cvReady
      ? (() => {
          const cropCanvas = document.createElement("canvas");
          cropCanvas.width = Math.round(r.width);
          cropCanvas.height = Math.round(r.height);
          cropCanvas
            .getContext("2d")
            .drawImage(capturedPhotoCanvas, r.x, r.y, r.width, r.height, 0, 0, cropCanvas.width, cropCanvas.height);
          const tight = deriveTightBoundingBox(cropCanvas);
          return tight ? { x: r.x + tight.x, y: r.y + tight.y, width: tight.width, height: tight.height } : r;
        })()
      : r;

    refAdjustNative = [
      { x: guessBox.x, y: guessBox.y },
      { x: guessBox.x + guessBox.width, y: guessBox.y },
      { x: guessBox.x + guessBox.width, y: guessBox.y + guessBox.height },
      { x: guessBox.x, y: guessBox.y + guessBox.height },
    ];
    layoutRefAdjustPoints();
  };
  img.src = capturedPhotoCanvas.toDataURL("image/jpeg", 0.95);
  showScreen("refAdjust");
}

function startDotDrag(index, clientX, clientY) {
  refAdjustDragIndex = index;
  moveDotDrag(clientX, clientY);
}

function moveDotDrag(clientX, clientY) {
  if (refAdjustDragIndex === null) return;
  const m = refAdjustDisplayMetrics();
  const stage = document.getElementById("refAdjustStage");
  const stageBox = stage.getBoundingClientRect();
  const nx = (clientX - stageBox.left - m.offsetX) / m.scale;
  const ny = (clientY - stageBox.top - m.offsetY) / m.scale;
  refAdjustNative[refAdjustDragIndex] = { x: nx, y: ny };
  layoutRefAdjustPoints();
}

function endDotDrag() {
  refAdjustDragIndex = null;
}

[0, 1, 2, 3].forEach((i) => {
  const dot = document.getElementById(`refDot${i}`);
  dot.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    startDotDrag(i, e.clientX, e.clientY);
  });
});
document.addEventListener("pointermove", (e) => moveDotDrag(e.clientX, e.clientY));
document.addEventListener("pointerup", endDotDrag);
document.addEventListener("pointercancel", endDotDrag);
window.addEventListener("resize", () => {
  if (!document.getElementById("refAdjustScreen").classList.contains("hidden")) layoutRefAdjustPoints();
});

function saveReferenceFromAdjustedCorners() {
  if (!refAdjustNative) return;
  if (!window.cvReady) {
    alert("Still loading the vision engine — wait a moment and try again.");
    return;
  }

  const [tl, tr, br, bl] = refAdjustNative;
  const outW = 350;
  const outH = 490; // matches a standard card's 2.5:3.5 aspect ratio
  const photoMat = cv.imread(capturedPhotoCanvas);
  const warped = new cv.Mat();
  const srcPts = cv.matFromArray(4, 1, cv.CV_32FC2, [tl.x, tl.y, tr.x, tr.y, br.x, br.y, bl.x, bl.y]);
  const dstPts = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, outW, 0, outW, outH, 0, outH]);
  const M = cv.getPerspectiveTransform(srcPts, dstPts);
  try {
    cv.warpPerspective(photoMat, warped, M, new cv.Size(outW, outH));
    const outCanvas = document.createElement("canvas");
    outCanvas.width = outW;
    outCanvas.height = outH;
    const imageData = new ImageData(new Uint8ClampedArray(warped.data), outW, outH);
    outCanvas.getContext("2d").putImageData(imageData, 0, 0);
    localStorage.setItem(REFERENCE_KEY, outCanvas.toDataURL("image/jpeg", 0.95));
    loadReferenceImageIntoMemory();
    updateReferenceStatus();
    showScreen("menu");
  } finally {
    photoMat.delete();
    warped.delete();
    srcPts.delete();
    dstPts.delete();
    M.delete();
  }
}

document.getElementById("refAdjustSaveBtn").addEventListener("click", saveReferenceFromAdjustedCorners);
document.getElementById("refAdjustBackBtn").addEventListener("click", () => {
  showScreen("camera");
  startCamera();
});

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

  if (captureMode === "reference") {
    showReferenceAdjustScreen();
    return;
  }

  runCardDetection();
  showDetectionPreview();
}

// Diagnostic mode: draws the detected card quad in green directly on the
// captured photo, with no card swap happening at all, so detection
// accuracy can be checked on its own before trusting it to composite
// anything on top of it.
function showDetectionPreview() {
  const canvas = document.getElementById("workCanvas");
  canvas.width = capturedPhotoCanvas.width;
  canvas.height = capturedPhotoCanvas.height;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(capturedPhotoCanvas, 0, 0);

  const quad = detectedQuad || fallbackQuadFromGuideRect();
  const lineWidth = Math.max(3, Math.round(canvas.width * 0.006));
  ctx.strokeStyle = "#00ff00";
  ctx.lineWidth = lineWidth;
  ctx.beginPath();
  ctx.moveTo(quad[0].x, quad[0].y);
  for (let i = 1; i < quad.length; i++) ctx.lineTo(quad[i].x, quad[i].y);
  ctx.closePath();
  ctx.stroke();

  const dotRadius = Math.max(5, Math.round(canvas.width * 0.009));
  ctx.fillStyle = "#00ff00";
  quad.forEach((p) => {
    ctx.beginPath();
    ctx.arc(p.x, p.y, dotRadius, 0, Math.PI * 2);
    ctx.fill();
  });

  const detectText = document.getElementById("detectStatus").textContent;
  const fontSize = Math.max(16, Math.round(canvas.width * 0.016));
  ctx.font = `${fontSize}px monospace`;
  const padding = fontSize * 0.5;
  const boxWidth = ctx.measureText(detectText).width + padding * 2;
  const boxHeight = fontSize * 1.6;
  ctx.fillStyle = "rgba(0,0,0,0.6)";
  ctx.fillRect(0, canvas.height - boxHeight, boxWidth, boxHeight);
  ctx.fillStyle = "#00ff00";
  ctx.fillText(detectText, padding, canvas.height - boxHeight * 0.3);

  document.getElementById("resultImage").src = canvas.toDataURL("image/jpeg", 0.92);
  document.getElementById("saveConfirm").classList.add("hidden");
  showScreen("gallery");
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

// Moves each corner toward the quad's centroid by `factor`, producing a
// smaller quad fully inside the original — used to protect the card's own
// interior from being mistaken for skin, since fingers only ever overlap
// a card near its edges.
function shrinkQuadTowardCentroid(quad, factor) {
  const cx = quad.reduce((s, p) => s + p.x, 0) / quad.length;
  const cy = quad.reduce((s, p) => s + p.y, 0) / quad.length;
  return quad.map((p) => ({
    x: cx + (p.x - cx) * (1 - factor),
    y: cy + (p.y - cy) * (1 - factor),
  }));
}

function polygonArea(pts) {
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    area += pts[i].x * pts[j].y - pts[j].x * pts[i].y;
  }
  return Math.abs(area / 2);
}

function isReasonableQuad(pts, photoW, photoH) {
  const area = polygonArea(pts);
  const minArea = photoW * photoH * 0.01;
  const maxArea = photoW * photoH * 0.9;
  if (area < minArea || area > maxArea) return false;
  return pts.every(
    (p) => p.x > -photoW * 0.2 && p.x < photoW * 1.2 && p.y > -photoH * 0.2 && p.y < photoH * 1.2
  );
}

// Finds the known reference card (always the real 9 of spades photographed
// via "Set Reference Card") inside the scene photo using ORB feature matching
// + homography, rather than guessing at generic edges in the scene.
function detectCardQuad(canvas) {
  if (!referenceImageEl || !referenceImageEl.complete || referenceImageEl.naturalWidth === 0) {
    return null;
  }

  const refCanvas = document.createElement("canvas");
  refCanvas.width = referenceImageEl.naturalWidth;
  refCanvas.height = referenceImageEl.naturalHeight;
  refCanvas.getContext("2d").drawImage(referenceImageEl, 0, 0);

  const refMat = cv.imread(refCanvas);
  const sceneMat = cv.imread(canvas);
  const refGray = new cv.Mat();
  const sceneGray = new cv.Mat();
  const refKeypoints = new cv.KeyPointVector();
  const sceneKeypoints = new cv.KeyPointVector();
  const refDescriptors = new cv.Mat();
  const sceneDescriptors = new cv.Mat();
  const emptyMask = new cv.Mat();
  const matches = new cv.DMatchVector();
  const orb = new cv.ORB(1500);
  const bf = new cv.BFMatcher(cv.NORM_HAMMING, true);
  let srcMat = null;
  let dstMat = null;
  let H = null;
  let refCorners = null;
  let sceneCorners = null;

  try {
    cv.cvtColor(refMat, refGray, cv.COLOR_RGBA2GRAY);
    cv.cvtColor(sceneMat, sceneGray, cv.COLOR_RGBA2GRAY);

    orb.detectAndCompute(refGray, emptyMask, refKeypoints, refDescriptors);
    orb.detectAndCompute(sceneGray, emptyMask, sceneKeypoints, sceneDescriptors);

    if (refDescriptors.rows < 10 || sceneDescriptors.rows < 10) return null;

    bf.match(refDescriptors, sceneDescriptors, matches);

    const matchArr = [];
    for (let i = 0; i < matches.size(); i++) matchArr.push(matches.get(i));
    if (matchArr.length < 15) return null;

    matchArr.sort((a, b) => a.distance - b.distance);
    const good = matchArr.slice(0, Math.min(80, matchArr.length));

    const srcPtsArr = [];
    const dstPtsArr = [];
    good.forEach((m) => {
      const rp = refKeypoints.get(m.queryIdx).pt;
      const sp = sceneKeypoints.get(m.trainIdx).pt;
      srcPtsArr.push(rp.x, rp.y);
      dstPtsArr.push(sp.x, sp.y);
    });

    srcMat = cv.matFromArray(good.length, 1, cv.CV_32FC2, srcPtsArr);
    dstMat = cv.matFromArray(good.length, 1, cv.CV_32FC2, dstPtsArr);
    H = cv.findHomography(srcMat, dstMat, cv.RANSAC, 5);
    if (H.empty()) return null;

    refCorners = cv.matFromArray(4, 1, cv.CV_32FC2, [
      0, 0,
      refCanvas.width, 0,
      refCanvas.width, refCanvas.height,
      0, refCanvas.height,
    ]);
    sceneCorners = new cv.Mat();
    cv.perspectiveTransform(refCorners, sceneCorners, H);

    const pts = [];
    for (let i = 0; i < 4; i++) {
      pts.push({ x: sceneCorners.data32F[i * 2], y: sceneCorners.data32F[i * 2 + 1] });
    }

    if (!isReasonableQuad(pts, canvas.width, canvas.height)) return null;
    return pts;
  } finally {
    refMat.delete();
    sceneMat.delete();
    refGray.delete();
    sceneGray.delete();
    refKeypoints.delete();
    sceneKeypoints.delete();
    refDescriptors.delete();
    sceneDescriptors.delete();
    emptyMask.delete();
    matches.delete();
    orb.delete();
    bf.delete();
    if (srcMat) srcMat.delete();
    if (dstMat) dstMat.delete();
    if (H) H.delete();
    if (refCorners) refCorners.delete();
    if (sceneCorners) sceneCorners.delete();
  }
}

function detectSkinMask(canvas) {
  const src = cv.imread(canvas);
  const rgb = new cv.Mat();
  const hsv = new cv.Mat();
  // H: reddish/orange hue range typical of skin (OpenCV hue is 0-179)
  // S: minimum saturation floor is the important part here — white/cream
  //    card backgrounds are low-saturation, so this excludes them even
  //    when lighting shifts their hue into the skin range
  // V: excludes near-black shadow pixels
  const low = new cv.Mat(src.rows, src.cols, cv.CV_8UC3, [0, 45, 60, 0]);
  const high = new cv.Mat(src.rows, src.cols, cv.CV_8UC3, [25, 180, 255, 0]);
  const mask = new cv.Mat();
  const kernel = cv.Mat.ones(5, 5, cv.CV_8U);

  try {
    cv.cvtColor(src, rgb, cv.COLOR_RGBA2RGB);
    cv.cvtColor(rgb, hsv, cv.COLOR_RGB2HSV);
    cv.inRange(hsv, low, high, mask);
    cv.morphologyEx(mask, mask, cv.MORPH_OPEN, kernel);
    cv.morphologyEx(mask, mask, cv.MORPH_CLOSE, kernel);
    cv.GaussianBlur(mask, mask, new cv.Size(9, 9), 0);
    return mask.clone();
  } finally {
    src.delete();
    rgb.delete();
    hsv.delete();
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
  if (!referenceImageEl) {
    detectedQuad = fallbackQuadFromGuideRect();
    setDetectStatus("No reference card set — using guide box instead.");
    return;
  }
  try {
    const quad = detectCardQuad(capturedPhotoCanvas);
    if (quad) {
      detectedQuad = quad;
      setDetectStatus("9♠ detected.");
    } else {
      detectedQuad = fallbackQuadFromGuideRect();
      setDetectStatus("9♠ not matched — using guide box instead.");
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
  const cardCtx = cardCanvas.getContext("2d");
  // flatten onto opaque white first — the card PNGs have transparent
  // rounded corners, which would otherwise leave faint alpha artifacts
  // after compositing and re-encoding as JPEG
  cardCtx.fillStyle = "#ffffff";
  cardCtx.fillRect(0, 0, cardCanvas.width, cardCanvas.height);
  cardCtx.drawImage(img, 0, 0);

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
  const innerQuad = shrinkQuadTowardCentroid(quad, 0.22);
  const innerMask = cv.Mat.zeros(photoMat.rows, photoMat.cols, cv.CV_8UC1);
  const innerPtsInt = cv.matFromArray(4, 1, cv.CV_32SC2, [
    innerQuad[0].x, innerQuad[0].y,
    innerQuad[1].x, innerQuad[1].y,
    innerQuad[2].x, innerQuad[2].y,
    innerQuad[3].x, innerQuad[3].y,
  ]);
  const innerVec = new cv.MatVector();
  let skinMask = null;
  let outerRing = null;
  let skinInRing = null;
  let notSkinInRing = null;
  let outerKept = null;
  let finalMask = null;

  let colorMatched = null;

  try {
    cv.warpPerspective(cardMat, warped, M, new cv.Size(photoMat.cols, photoMat.rows));
    quadVec.push_back(quadPtsInt);
    cv.fillPoly(quadMask, quadVec, new cv.Scalar(255));
    innerVec.push_back(innerPtsInt);
    cv.fillPoly(innerMask, innerVec, new cv.Scalar(255));

    // fingers only ever overlap a held card near its edges, never its
    // center — so only let skin detection cut into the outer ring of the
    // quad, and always treat the shrunk interior as fully covered by the
    // new card. Without this, a false-positive skin match anywhere on the
    // real card's own surface (e.g. under warm indoor lighting or glare)
    // erases large parts of the replacement and lets the original card
    // show through underneath it.
    skinMask = detectSkinMask(capturedPhotoCanvas);
    outerRing = new cv.Mat();
    cv.bitwise_xor(quadMask, innerMask, outerRing);
    skinInRing = new cv.Mat();
    cv.bitwise_and(skinMask, outerRing, skinInRing);
    notSkinInRing = new cv.Mat();
    cv.bitwise_not(skinInRing, notSkinInRing);
    outerKept = new cv.Mat();
    cv.bitwise_and(outerRing, notSkinInRing, outerKept);
    finalMask = new cv.Mat();
    cv.bitwise_or(innerMask, outerKept, finalMask);
    // soften the mask edge so the card-to-thumb boundary blends smoothly
    // instead of a hard, jagged on/off cut
    cv.GaussianBlur(finalMask, finalMask, new cv.Size(11, 11), 0);

    try {
      colorMatched = matchColorToRegion(warped, photoMat, finalMask);
    } catch (err) {
      colorMatched = null; // fall back to the un-matched warp below
    }
    const finalCardMat = colorMatched || warped;

    // composite via canvas alpha blending (using finalMask as the alpha
    // channel) rather than a hard copyTo, so the soft mask edge actually
    // produces a smooth blended boundary
    const w = photoMat.cols;
    const h = photoMat.rows;
    const layerData = new Uint8ClampedArray(w * h * 4);
    const colorData = finalCardMat.data;
    const maskData = finalMask.data;
    for (let i = 0; i < w * h; i++) {
      layerData[i * 4] = colorData[i * 4];
      layerData[i * 4 + 1] = colorData[i * 4 + 1];
      layerData[i * 4 + 2] = colorData[i * 4 + 2];
      layerData[i * 4 + 3] = maskData[i];
    }
    const layerCanvas = document.createElement("canvas");
    layerCanvas.width = w;
    layerCanvas.height = h;
    layerCanvas.getContext("2d").putImageData(new ImageData(layerData, w, h), 0, 0);

    const ctx = canvas.getContext("2d");
    ctx.drawImage(capturedPhotoCanvas, 0, 0);
    ctx.drawImage(layerCanvas, 0, 0);
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
    innerMask.delete();
    innerPtsInt.delete();
    innerVec.delete();
    if (skinMask) skinMask.delete();
    if (outerRing) outerRing.delete();
    if (skinInRing) skinInRing.delete();
    if (notSkinInRing) notSkinInRing.delete();
    if (outerKept) outerKept.delete();
    if (finalMask) finalMask.delete();
    if (colorMatched) colorMatched.delete();
  }
}

// Samples the real card's actual white background color under the room's
// current lighting (brightness + color cast), then applies that as a
// per-channel white-balance gain to the replacement card — this targets
// the card's white background specifically, rather than an overall
// statistical average that tends to under-correct flat white areas.
function matchColorToRegion(srcRgba, targetRgba, mask) {
  const targetRgb = new cv.Mat();
  const gray = new cv.Mat();
  const brightMask = new cv.Mat();
  const combinedMask = new cv.Mat();
  const channels = new cv.MatVector();
  let adjusted = null;

  try {
    cv.cvtColor(targetRgba, targetRgb, cv.COLOR_RGBA2RGB);
    cv.cvtColor(targetRgb, gray, cv.COLOR_RGB2GRAY);

    const stats = cv.minMaxLoc(gray, mask);
    const brightThresh = Math.max(0, stats.maxVal - 30);
    cv.threshold(gray, brightMask, brightThresh, 255, cv.THRESH_BINARY);
    cv.bitwise_and(brightMask, mask, combinedMask);

    const whiteMean = cv.mean(targetRgb, combinedMask);
    const gain = [0, 1, 2].map((c) => Math.max(0.2, Math.min(1.3, whiteMean[c] / 255)));

    cv.split(srcRgba, channels);
    for (let c = 0; c < 3; c++) {
      const ch = channels.get(c);
      cv.convertScaleAbs(ch, ch, gain[c], 0);
    }
    adjusted = new cv.Mat();
    cv.merge(channels, adjusted);
    return adjusted;
  } finally {
    targetRgb.delete();
    gray.delete();
    brightMask.delete();
    combinedMask.delete();
    channels.delete();
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
  captureMode = "trick";
  setCameraHint("Keep the card roughly inside the outline");
  showScreen("camera");
  startCamera();
});

document.getElementById("setReferenceBtn").addEventListener("click", () => {
  captureMode = "reference";
  setCameraHint("Align your real 9 of spades, then tap capture");
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
