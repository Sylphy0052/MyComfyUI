import { Button, FileButton, Group, Image, SegmentedControl, Slider, Stack, Text } from "@mantine/core";
import { IconRefresh, IconUpload } from "@tabler/icons-react";
import { useEffect, useRef, useState, type PointerEvent } from "react";

import { notifyError } from "../notifications";
import { uploadedImage, type UploadedImage } from "./deriveForm";
import { useUploadInputImage } from "./useImageGen";

/** 塗った範囲の色。ComfyUIの`LoadImageMask`は赤のchannelをマスクとして読む (`anima_inpaint.json`)。 */
const PAINT = "#ff0000";
/** ブラシの太さ (表示上のpx)。 */
const BRUSH_DEFAULT = 24;
const BRUSH_MIN = 4;
const BRUSH_MAX = 120;
const BRUSH_STEP = 2;
/** 元画像を表示する高さの上限 (px)。 */
const SOURCE_MAX_HEIGHT = 420;
/** 塗りを元画像に重ねて見せるときの不透明度。 */
const OVERLAY_OPACITY = 0.5;

type Tool = "brush" | "eraser";

const TOOLS: { value: Tool; label: string }[] = [
  { value: "brush", label: "ブラシ" },
  { value: "eraser", label: "消しゴム" },
];

type Point = { x: number; y: number };

/** canvasに何か塗ってあるか。 */
function hasPaint(canvas: HTMLCanvasElement): boolean {
  const { data } = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height);
  for (let i = 3; i < data.length; i += 4) if (data[i] > 0) return true;
  return false;
}

/** 塗った範囲を、黒地に赤のPNGにする。大きさはcanvasと同じ (元画像の解像度)。 */
function maskPng(canvas: HTMLCanvasElement): Promise<File> {
  const out = document.createElement("canvas");
  out.width = canvas.width;
  out.height = canvas.height;
  const ctx = out.getContext("2d")!;
  ctx.fillStyle = "#000000";
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(canvas, 0, 0);
  return new Promise((resolve, reject) =>
    out.toBlob((blob) => {
      if (blob === null) reject(new Error("マスクをPNGにできません"));
      else resolve(new File([blob], "mask.png", { type: "image/png" }));
    }, "image/png"),
  );
}

/** マスク画像をcanvasへ描き戻す。赤のchannelの濃さを、塗りの濃さにする。大きさは元画像に合わせて伸縮する。 */
function paintFromMask(canvas: HTMLCanvasElement, image: HTMLImageElement) {
  const work = document.createElement("canvas");
  work.width = canvas.width;
  work.height = canvas.height;
  const workCtx = work.getContext("2d")!;
  workCtx.drawImage(image, 0, 0, work.width, work.height);
  const pixels = workCtx.getImageData(0, 0, work.width, work.height);
  const { data } = pixels;
  // 画素はR, G, B, Aの順。Rの濃さをAへ移し、色はPAINTの赤に揃える (黒地は透明になる)。
  for (let i = 0; i < data.length; i += 4) {
    data[i + 3] = data[i];
    data[i] = 255;
    data[i + 1] = 0;
    data[i + 2] = 0;
  }
  canvas.getContext("2d")!.putImageData(pixels, 0, 0);
}

/**
 * 元画像の上にブラシでマスクを描く。canvasは元画像と同じ解像度で持ち、表示の大きさとは切り離す。
 * 塗り終えるたびに黒地に赤のPNGへ書き出して取り込み、`mask`にする。アップロードしたマスクもcanvasへ描き戻して続きを塗れる。
 * 元画像が変わったら作り直す前提なので、呼び出し側は元画像ごとに`key`を変える。
 */
export function MaskPainter({
  sourceUrl,
  mask,
  onClearMask,
  reserveMask,
}: {
  sourceUrl: string;
  mask: UploadedImage | null;
  /** 送るマスクを外す。塗り始めと全消去で呼ぶ。 */
  onClearMask: () => void;
  /** マスクを取り込む前に呼び、返り値へ取り込んだマスクを渡す。 */
  reserveMask: () => (mask: UploadedImage) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const [sourceFailed, setSourceFailed] = useState(false);
  const [tool, setTool] = useState<Tool>("brush");
  // 太さは表示上の太さで持ち、塗るときに元画像の解像度へ換算する。
  const [brush, setBrush] = useState(BRUSH_DEFAULT);
  // 描いたマスクの取り込みに失敗し、canvasの塗りがまだ送られていない。
  const [commitFailed, setCommitFailed] = useState(false);
  const upload = useUploadInputImage();
  // 塗っている最中のpointerと直前の点。2本目の指など、別のpointerは無視する。
  const stroke = useRef<{ pointerId: number; last: Point } | null>(null);
  // 取り込みや消去のたびに進め、後から塗り直しや消去があれば、先に始めた取り込みの結果を捨てる。
  const seq = useRef(0);
  // 塗り始めてから取り込みが終わるまで`mask`は空にしておくため、その間はcanvasを消さない。
  const pending = useRef(false);
  // canvasの内容から取り込んだマスク。描き戻さない。
  const drawn = useRef<string | null>(null);

  const nextSeq = () => {
    seq.current += 1;
    return seq.current;
  };

  // `mask`が外から変わったらcanvasへ反映する。空になったら消し、アップロードや描き直し前のマスクなら描き戻す。
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null || size === null) return;
    if (mask === null) {
      if (!pending.current) canvas.getContext("2d")!.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }
    if (mask.previewUrl === drawn.current) return;
    let cancelled = false;
    const image = new window.Image();
    image.onload = () => {
      if (cancelled) return;
      try {
        paintFromMask(canvas, image);
        drawn.current = mask.previewUrl;
      } catch (error) {
        notifyError("マスク画像をcanvasへ描き戻せません", error);
      }
    };
    image.onerror = () => {
      if (!cancelled) notifyError("マスク画像を読み込めません", new Error(mask.label));
    };
    image.src = mask.previewUrl;
    return () => {
      cancelled = true;
    };
  }, [mask, size]);

  const pointOf = (event: PointerEvent<HTMLCanvasElement>): Point => {
    const canvas = event.currentTarget;
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) * canvas.width) / rect.width,
      y: ((event.clientY - rect.top) * canvas.height) / rect.height,
    };
  };

  const paint = (canvas: HTMLCanvasElement, from: Point | null, to: Point) => {
    const ctx = canvas.getContext("2d")!;
    const width = (brush * canvas.width) / canvas.getBoundingClientRect().width;
    ctx.globalCompositeOperation = tool === "eraser" ? "destination-out" : "source-over";
    ctx.strokeStyle = PAINT;
    ctx.fillStyle = PAINT;
    ctx.lineWidth = width;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    if (from === null) {
      ctx.arc(to.x, to.y, width / 2, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(to.x, to.y);
      ctx.stroke();
    }
  };

  /** canvasの内容をマスクとして取り込む。失敗したら塗りを残し、「取り込み直す」を出す。 */
  const commit = async (canvas: HTMLCanvasElement) => {
    const mine = nextSeq();
    const apply = reserveMask();
    setCommitFailed(false);
    try {
      if (!hasPaint(canvas)) {
        pending.current = false;
        drawn.current = null;
        return;
      }
      const reference = await upload.mutateAsync(await maskPng(canvas));
      if (mine !== seq.current) return;
      pending.current = false;
      const next = uploadedImage(reference, "描いたマスク");
      drawn.current = next.previewUrl;
      apply(next);
    } catch (error) {
      if (mine !== seq.current) return;
      pending.current = false;
      setCommitFailed(true);
      notifyError("描いたマスクを取り込めません", error);
    }
  };

  const onPointerDown = (event: PointerEvent<HTMLCanvasElement>) => {
    if (size === null || event.button !== 0 || stroke.current !== null) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    nextSeq();
    pending.current = true;
    // 塗り終えて取り込むまでは、塗る前のマスクで投入されないよう外しておく。
    if (mask !== null) onClearMask();
    const point = pointOf(event);
    paint(event.currentTarget, null, point);
    stroke.current = { pointerId: event.pointerId, last: point };
  };

  const onPointerMove = (event: PointerEvent<HTMLCanvasElement>) => {
    if (stroke.current === null || stroke.current.pointerId !== event.pointerId) return;
    const point = pointOf(event);
    paint(event.currentTarget, stroke.current.last, point);
    stroke.current = { pointerId: event.pointerId, last: point };
  };

  const onPointerUp = (event: PointerEvent<HTMLCanvasElement>) => {
    if (stroke.current === null || stroke.current.pointerId !== event.pointerId) return;
    stroke.current = null;
    void commit(event.currentTarget);
  };

  const retry = () => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    pending.current = true;
    void commit(canvas);
  };

  const clear = () => {
    nextSeq();
    pending.current = false;
    drawn.current = null;
    setCommitFailed(false);
    const canvas = canvasRef.current;
    if (canvas !== null) canvas.getContext("2d")!.clearRect(0, 0, canvas.width, canvas.height);
    onClearMask();
  };

  const uploadFile = (file: File | null) => {
    if (file === null) return;
    const mine = nextSeq();
    pending.current = false;
    setCommitFailed(false);
    const apply = reserveMask();
    // mutateの個別コールバックは入力欄を閉じると呼ばれないため、mutateAsyncで受ける。
    upload.mutateAsync(file).then(
      (reference) => {
        if (mine === seq.current) apply(uploadedImage(reference, file.name));
      },
      (error: unknown) => {
        if (mine === seq.current) notifyError(`${file.name}を取り込めません`, error);
      },
    );
  };

  return (
    <Stack gap="xs" data-testid="mask-painter">
      {/* 元画像とcanvasを同じ枠に重ねる。枠は元画像の表示の大きさに縮め、lineHeight: 0でimgの下にできる行間の隙間を消す。 */}
      <div style={{ position: "relative", display: "inline-block", alignSelf: "flex-start", maxWidth: "100%", lineHeight: 0 }}>
        {/* canvasと大きさを揃えて重ねるため、Mantineの`Image`でなく素の`img`で出す。 */}
        <img
          src={sourceUrl}
          alt="マスクを描く元画像"
          style={{ display: "block", maxWidth: "100%", maxHeight: SOURCE_MAX_HEIGHT }}
          onLoad={(event) => {
            setSourceFailed(false);
            setSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight });
          }}
          onError={() => setSourceFailed(true)}
        />
        {/* canvasは元画像の上に全面で重ねる。touchAction: noneで、タッチで塗るときに画面がスクロールしないようにする。元画像を読み込むまでは塗らせない。 */}
        <canvas
          ref={canvasRef}
          width={size?.width}
          height={size?.height}
          data-testid="mask-canvas"
          aria-label="マスクを描く範囲"
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            opacity: OVERLAY_OPACITY,
            cursor: "crosshair",
            touchAction: "none",
            pointerEvents: size === null ? "none" : "auto",
          }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        />
      </div>
      {sourceFailed ? (
        <Text size="xs" c="red" data-testid="mask-source-error">
          元画像を読み込めないため、マスクを描けません。マスク画像のアップロードは使えます。
        </Text>
      ) : null}
      <Group gap="sm" wrap="wrap" align="center">
        <SegmentedControl size="xs" data={TOOLS} value={tool} onChange={(value) => setTool(value as Tool)} />
        <Group gap={6} wrap="nowrap" w={200}>
          <Text size="xs" style={{ whiteSpace: "nowrap" }}>
            太さ
          </Text>
          <Slider
            flex={1}
            min={BRUSH_MIN}
            max={BRUSH_MAX}
            step={BRUSH_STEP}
            value={brush}
            onChange={setBrush}
            thumbLabel="ブラシの太さ"
            data-testid="brush-size"
          />
        </Group>
        <Button size="compact-xs" variant="default" onClick={clear}>
          全消去
        </Button>
      </Group>
      {commitFailed ? (
        <Group gap="sm" wrap="nowrap" data-testid="mask-commit-failed">
          <Text size="xs" c="red">
            描いたマスクを取り込めませんでした。
          </Text>
          <Button
            size="compact-xs"
            variant="light"
            leftSection={<IconRefresh size={14} />}
            loading={upload.isPending}
            onClick={retry}
          >
            取り込み直す
          </Button>
        </Group>
      ) : null}
      <Group gap="sm" wrap="nowrap">
        <FileButton accept="image/png,image/jpeg,image/webp" onChange={uploadFile}>
          {(props) => (
            <Button {...props} size="xs" variant="light" leftSection={<IconUpload size={14} />} loading={upload.isPending}>
              マスク画像をアップロード
            </Button>
          )}
        </FileButton>
        {mask !== null ? (
          <Image src={mask.previewUrl} alt="送るマスク画像" h={64} w="auto" fit="contain" data-testid="mask-preview" />
        ) : null}
      </Group>
    </Stack>
  );
}
