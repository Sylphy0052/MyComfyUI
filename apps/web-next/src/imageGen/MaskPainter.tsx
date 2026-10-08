import { Button, FileButton, Group, Image, SegmentedControl, Slider, Stack, Text } from "@mantine/core";
import { IconUpload } from "@tabler/icons-react";
import { useEffect, useRef, useState, type PointerEvent } from "react";

import { notifyError } from "../notifications";
import { uploadedImage, type UploadedImage } from "./deriveForm";
import { useUploadInputImage } from "./useImageGen";

/** 塗った範囲の色。ComfyUIの`LoadImageMask`は赤のchannelをマスクとして読む (`anima_inpaint.json`)。 */
const PAINT = "#ff0000";

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
  onChange,
  reserveMask,
}: {
  sourceUrl: string;
  mask: UploadedImage | null;
  onChange: (update: { mask: null }) => void;
  /** マスクを取り込む前に呼び、返り値へ取り込んだマスクを渡す。 */
  reserveMask: () => (mask: UploadedImage) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const [tool, setTool] = useState<Tool>("brush");
  // 太さは表示上の太さで持ち、塗るときに元画像の解像度へ換算する。
  const [brush, setBrush] = useState(24);
  const upload = useUploadInputImage();
  const last = useRef<Point | null>(null);
  // 取り込みや消去のたびに進め、後から塗り直しや消去があれば、先に始めた取り込みの結果を捨てる。
  const seq = useRef(0);
  // 塗り始めてから取り込みが終わるまで`mask`は空にしておくため、その間はcanvasを消さない。
  const pending = useRef(false);
  // canvasの内容から取り込んだマスク。描き戻さない。
  const drawn = useRef<string | null>(null);

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
      paintFromMask(canvas, image);
      drawn.current = mask.previewUrl;
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

  const onPointerDown = (event: PointerEvent<HTMLCanvasElement>) => {
    if (size === null || event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    seq.current += 1;
    pending.current = true;
    // 塗り終えて取り込むまでは、塗る前のマスクで投入されないよう外しておく。
    if (mask !== null) onChange({ mask: null });
    const point = pointOf(event);
    paint(event.currentTarget, null, point);
    last.current = point;
  };

  const onPointerMove = (event: PointerEvent<HTMLCanvasElement>) => {
    if (last.current === null) return;
    const point = pointOf(event);
    paint(event.currentTarget, last.current, point);
    last.current = point;
  };

  const onPointerUp = (event: PointerEvent<HTMLCanvasElement>) => {
    if (last.current === null) return;
    last.current = null;
    const canvas = event.currentTarget;
    const mine = ++seq.current;
    const apply = reserveMask();
    if (!hasPaint(canvas)) {
      pending.current = false;
      drawn.current = null;
      return;
    }
    maskPng(canvas)
      .then((file) => upload.mutateAsync(file))
      .then(
        (reference) => {
          if (mine !== seq.current) return;
          pending.current = false;
          const next = uploadedImage(reference, "描いたマスク");
          drawn.current = next.previewUrl;
          apply(next);
        },
        (error: unknown) => {
          if (mine !== seq.current) return;
          pending.current = false;
          notifyError("描いたマスクを取り込めません", error);
        },
      );
  };

  const clear = () => {
    seq.current += 1;
    pending.current = false;
    drawn.current = null;
    const canvas = canvasRef.current;
    if (canvas !== null) canvas.getContext("2d")!.clearRect(0, 0, canvas.width, canvas.height);
    onChange({ mask: null });
  };

  const uploadFile = (file: File | null) => {
    if (file === null) return;
    const mine = ++seq.current;
    pending.current = false;
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
      <div style={{ position: "relative", display: "inline-block", alignSelf: "flex-start", maxWidth: "100%", lineHeight: 0 }}>
        <img
          src={sourceUrl}
          alt="マスクを描く元画像"
          style={{ display: "block", maxWidth: "100%", maxHeight: 420 }}
          onLoad={(event) =>
            setSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })
          }
        />
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
            opacity: 0.5,
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
      <Group gap="sm" wrap="wrap" align="center">
        <SegmentedControl size="xs" data={TOOLS} value={tool} onChange={(value) => setTool(value as Tool)} />
        <Group gap={6} wrap="nowrap" w={200}>
          <Text size="xs" style={{ whiteSpace: "nowrap" }}>
            太さ
          </Text>
          <Slider
            flex={1}
            min={4}
            max={120}
            step={2}
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
