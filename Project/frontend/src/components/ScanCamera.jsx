import { useEffect, useRef, useState } from "react";

function supported() {
  return typeof window !== "undefined" && "BarcodeDetector" in window;
}

export default function ScanCamera({ t, onDecode, scanKey = 0, continuous = true }) {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const fileRef = useRef(null);
  const streamRef = useRef(null);
  const loopRef = useRef(null);
  const doneRef = useRef(false);
  const onDecodeRef = useRef(onDecode);
  onDecodeRef.current = onDecode;
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [torchOn, setTorchOn] = useState(false);
  const [torchOk, setTorchOk] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [zoomCaps, setZoomCaps] = useState(null);

  const clearLoop = () => {
    clearInterval(loopRef.current); loopRef.current = null;
    setScanning(false);
  };

  const stop = () => {
    clearLoop();
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((tr) => tr.stop());
      streamRef.current = null;
    }
    setTorchOn(false);
    setOpen(false);
  };

  useEffect(() => () => {
    clearInterval(loopRef.current);
    if (streamRef.current) streamRef.current.getTracks().forEach((tr) => tr.stop());
  }, []);

  // Parent resets for next person via scanKey change: re-arm continuous loop.
  useEffect(() => {
    doneRef.current = false;
    if (open && continuous && !loopRef.current) startLoop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scanKey]);

  const detectFrame = async () => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || !video.videoWidth || doneRef.current) return;
    try {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      canvas.getContext("2d").drawImage(video, 0, 0);
      const Detector = window.BarcodeDetector;
      const det = new Detector({ formats: ["qr_code"] });
      const codes = await det.detect(canvas);
      const raw = codes?.[0]?.rawValue;
      if (raw) {
        doneRef.current = true;
        clearLoop();
        onDecodeRef.current && onDecodeRef.current(raw);
        stop();
      }
    } catch {
      /* keep looping; decode errors surface via manual capture */
    }
  };

  const startLoop = () => {
    if (loopRef.current || doneRef.current) return;
    setScanning(true);
    loopRef.current = window.setInterval(detectFrame, 600);
  };

  const start = async () => {
    setErr("");
    doneRef.current = false;
    if (!supported()) { setErr(t("camera_unsupported")); return; }
    if (!navigator.mediaDevices?.getUserMedia) { setErr(t("camera_unsupported")); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
      streamRef.current = stream;
      setOpen(true);
      try {
        const tr = stream.getVideoTracks && stream.getVideoTracks()[0];
        const caps = tr && typeof tr.getCapabilities === "function" ? tr.getCapabilities() : null;
        setTorchOk(!!(caps && caps.torch));
        if (caps && caps.zoom) setZoomCaps({ min: caps.zoom.min ?? 1, max: Math.min(caps.zoom.max ?? 3, 3), step: caps.zoom.step ?? 0.1 });
        else setZoomCaps(null);
      } catch {
        setTorchOk(false);
        setZoomCaps(null);
      }
      if (continuous) window.setTimeout(startLoop, 300);
    } catch {
      setErr(t("camera_denied"));
    }
  };

  useEffect(() => {
    if (open && videoRef.current && streamRef.current) {
      videoRef.current.srcObject = streamRef.current;
      videoRef.current.play().catch(() => {});
    }
  }, [open]);

  const capture = async () => {
    setErr("");
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || !video.videoWidth) { setErr(t("camera_no_qr")); return; }
    setBusy(true);
    try {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      canvas.getContext("2d").drawImage(video, 0, 0);
      const Detector = window.BarcodeDetector;
      const det = new Detector({ formats: ["qr_code"] });
      const codes = await det.detect(canvas);
      const raw = codes?.[0]?.rawValue;
      if (raw) {
        doneRef.current = true;
        clearLoop();
        onDecode(raw);
        stop();
      } else {
        setErr(t("camera_no_qr"));
      }
    } catch {
      setErr(t("camera_unsupported"));
    } finally {
      setBusy(false);
    }
  };

  const toggleTorch = async () => {
    try {
      const tr = streamRef.current && streamRef.current.getVideoTracks && streamRef.current.getVideoTracks()[0];
      if (!tr || typeof tr.applyConstraints !== "function") return;
      await tr.applyConstraints({ advanced: [{ torch: !torchOn }] });
      setTorchOn((v) => !v);
    } catch {
      setTorchOk(false);
    }
  };

  const applyZoom = async (v) => {
    setZoom(v);
    try {
      const tr = streamRef.current && streamRef.current.getVideoTracks && streamRef.current.getVideoTracks()[0];
      if (!tr || typeof tr.applyConstraints !== "function") return;
      await tr.applyConstraints({ advanced: [{ zoom: Number(v) }] });
    } catch { /* ignore */ }
  };

  const onUpload = async (e) => {
    setErr("");
    const f = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!f) return;
    if (!supported()) { setErr(t("camera_unsupported")); return; }
    try {
      const url = URL.createObjectURL(f);
      const img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
      const canvas = canvasRef.current;
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      canvas.getContext("2d").drawImage(img, 0, 0);
      URL.revokeObjectURL(url);
      const Detector = window.BarcodeDetector;
      const det = new Detector({ formats: ["qr_code"] });
      const codes = await det.detect(canvas);
      const raw = codes?.[0]?.rawValue;
      if (raw) {
        doneRef.current = true;
        onDecode(raw);
      } else {
        setErr(t("camera_no_qr"));
      }
    } catch {
      setErr(t("camera_no_qr"));
    }
  };

  if (!open && !err) {
    return (
      <div className="row no-print">
        <button type="button" className="small" onClick={start}>{t("camera_scan")}</button>
        <input ref={fileRef} type="file" accept="image/*" hidden onChange={onUpload} aria-label={t("upload_photo")} />
        <button type="button" className="small ghost-dark" onClick={() => fileRef.current && fileRef.current.click()}>{t("upload_photo")}</button>
        <canvas ref={canvasRef} hidden aria-hidden="true" />
      </div>
    );
  }

  return (
    <div className="no-print scan-camera">
      {open && (
        <>
          <video ref={videoRef} className="scan-video" muted playsInline aria-label="camera preview" />
          {scanning && <p className="hint" role="status">{t("camera_continuous")}</p>}
          <div className="row">
            <button type="button" className="small" onClick={capture} disabled={busy}>
              {busy ? t("verifying") : t("camera_capture")}
            </button>
            {torchOk && (
              <button type="button" className="small ghost-dark" onClick={toggleTorch}>
                {torchOn ? t("torch_off") : t("torch_on")}
              </button>
            )}
            <button type="button" className="small ghost-dark" onClick={stop}>{t("camera_stop")}</button>
          </div>
          {zoomCaps && (
            <div className="row">
              <label>{t("zoom")} <input type="range" min={zoomCaps.min} max={zoomCaps.max} step={zoomCaps.step} value={zoom} onChange={(e) => applyZoom(Number(e.target.value))} /> {Number(zoom).toFixed(1)}x</label>
            </div>
          )}
          <div className="row">
            <button type="button" className="small ghost-dark" onClick={() => { doneRef.current = false; startLoop(); }}>{t("camera_scan_next")}</button>
          </div>
        </>
      )}
      {!open && (
        <div className="row">
          <button type="button" className="small" onClick={start}>{t("camera_scan")}</button>
          <input ref={fileRef} type="file" accept="image/*" hidden onChange={onUpload} aria-label={t("upload_photo")} />
          <button type="button" className="small ghost-dark" onClick={() => fileRef.current && fileRef.current.click()}>{t("upload_photo")}</button>
        </div>
      )}
      {err && <p className="error" role="alert">{err}</p>}
      <canvas ref={canvasRef} hidden aria-hidden="true" />
    </div>
  );
}
