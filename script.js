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
  ["menu", "camera", "pick", "gallery"].forEach((n) => {
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

function saveReferenceCardFromCapture() {
  const r = guideRectNative;
  const cropCanvas = document.createElement("canvas");
  cropCanvas.width = Math.round(r.width);
  cropCanvas.height = Math.round(r.height);
  cropCanvas
    .getContext("2d")
    .drawImage(capturedPhotoCanvas, r.x, r.y, r.width, r.height, 0, 0, cropCanvas.width, cropCanvas.height);
  localStorage.setItem(REFERENCE_KEY, cropCanvas.toDataURL("image/jpeg", 0.95));
  loadReferenceImageIntoMemory();
  updateReferenceStatus();
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

  if (captureMode === "reference") {
    saveReferenceCardFromCapture();
    showScreen("menu");
    return;
  }

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
  let skinMask = null;
  let notSkin = null;
  let finalMask = null;

  let colorMatched = null;

  try {
    cv.warpPerspective(cardMat, warped, M, new cv.Size(photoMat.cols, photoMat.rows));
    quadVec.push_back(quadPtsInt);
    cv.fillPoly(quadMask, quadVec, new cv.Scalar(255));

    skinMask = detectSkinMask(capturedPhotoCanvas);
    notSkin = new cv.Mat();
    cv.bitwise_not(skinMask, notSkin);
    finalMask = new cv.Mat();
    cv.bitwise_and(quadMask, notSkin, finalMask);

    try {
      colorMatched = matchColorToRegion(warped, photoMat, finalMask);
    } catch (err) {
      colorMatched = null; // fall back to the un-matched warp below
    }

    (colorMatched || warped).copyTo(photoMat, finalMask);
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
    if (colorMatched) colorMatched.delete();
  }
}

// Rescales `srcRgba`'s LAB color statistics (lightness, color temperature,
// contrast) to match `targetRgba`'s statistics within `mask`, so the pasted
// card picks up the real photo's actual lighting instead of looking flat.
function matchColorToRegion(srcRgba, targetRgba, mask) {
  const srcRgb = new cv.Mat();
  const targetRgb = new cv.Mat();
  const srcLab = new cv.Mat();
  const targetLab = new cv.Mat();
  const srcMean = new cv.Mat();
  const srcStd = new cv.Mat();
  const targetMean = new cv.Mat();
  const targetStd = new cv.Mat();
  let adjustedRgb = null;
  let adjustedRgba = null;

  try {
    cv.cvtColor(srcRgba, srcRgb, cv.COLOR_RGBA2RGB);
    cv.cvtColor(targetRgba, targetRgb, cv.COLOR_RGBA2RGB);
    cv.cvtColor(srcRgb, srcLab, cv.COLOR_RGB2Lab);
    cv.cvtColor(targetRgb, targetLab, cv.COLOR_RGB2Lab);

    cv.meanStdDev(srcLab, srcMean, srcStd, mask);
    cv.meanStdDev(targetLab, targetMean, targetStd, mask);

    const sm = [srcMean.doubleAt(0, 0), srcMean.doubleAt(1, 0), srcMean.doubleAt(2, 0)];
    const ss = [srcStd.doubleAt(0, 0), srcStd.doubleAt(1, 0), srcStd.doubleAt(2, 0)];
    const tm = [targetMean.doubleAt(0, 0), targetMean.doubleAt(1, 0), targetMean.doubleAt(2, 0)];
    const ts = [targetStd.doubleAt(0, 0), targetStd.doubleAt(1, 0), targetStd.doubleAt(2, 0)];

    const data = srcLab.data;
    for (let i = 0; i < data.length; i += 3) {
      for (let c = 0; c < 3; c++) {
        const std = ss[c] < 1e-3 ? 1 : ss[c];
        const v = (data[i + c] - sm[c]) * (ts[c] / std) + tm[c];
        data[i + c] = Math.max(0, Math.min(255, v));
      }
    }

    adjustedRgb = new cv.Mat();
    cv.cvtColor(srcLab, adjustedRgb, cv.COLOR_Lab2RGB);
    adjustedRgba = new cv.Mat();
    cv.cvtColor(adjustedRgb, adjustedRgba, cv.COLOR_RGB2RGBA);
    return adjustedRgba;
  } finally {
    srcRgb.delete();
    targetRgb.delete();
    srcLab.delete();
    targetLab.delete();
    srcMean.delete();
    srcStd.delete();
    targetMean.delete();
    targetStd.delete();
    if (adjustedRgb) adjustedRgb.delete();
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
