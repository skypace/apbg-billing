import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import { Eraser } from 'lucide-react';

export interface SignaturePadHandle {
  /** PNG data-URL of the drawn signature, or null when empty. */
  toDataURL(): string | null;
  clear(): void;
  isEmpty(): boolean;
}

/**
 * Minimal canvas signature pad — pointer events (mouse / touch / pen),
 * device-pixel-ratio aware, with a Clear button. Value is read imperatively
 * via the ref (`toDataURL()` → 'image/png' data-URL).
 */
export const SignaturePad = forwardRef<SignaturePadHandle, { height?: number }>(
  function SignaturePad({ height = 160 }, ref) {
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const boxRef = useRef<HTMLDivElement | null>(null);
    const drawingRef = useRef(false);
    const [empty, setEmpty] = useState(true);
    const emptyRef = useRef(true);

    function markDrawn() {
      if (emptyRef.current) {
        emptyRef.current = false;
        setEmpty(false);
      }
    }

    // Size the backing store to the rendered box × devicePixelRatio.
    useEffect(() => {
      const canvas = canvasRef.current;
      const box = boxRef.current;
      if (!canvas || !box) return;
      const dpr = window.devicePixelRatio || 1;
      const rect = box.getBoundingClientRect();
      canvas.width = Math.max(1, Math.round(rect.width * dpr));
      canvas.height = Math.max(1, Math.round(rect.height * dpr));
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.scale(dpr, dpr);
        ctx.lineWidth = 2.25;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.strokeStyle = document.documentElement.classList.contains('dark')
          ? '#f2f2f5'
          : '#1d1d1f';
      }
    }, [height]);

    function pos(e: React.PointerEvent<HTMLCanvasElement>) {
      const rect = e.currentTarget.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    }

    function onDown(e: React.PointerEvent<HTMLCanvasElement>) {
      e.preventDefault();
      const ctx = canvasRef.current?.getContext('2d');
      if (!ctx) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      drawingRef.current = true;
      const { x, y } = pos(e);
      ctx.beginPath();
      ctx.moveTo(x, y);
      // A dot for a tap-only signature stroke.
      ctx.lineTo(x + 0.01, y + 0.01);
      ctx.stroke();
      markDrawn();
    }

    function onMove(e: React.PointerEvent<HTMLCanvasElement>) {
      if (!drawingRef.current) return;
      const ctx = canvasRef.current?.getContext('2d');
      if (!ctx) return;
      const { x, y } = pos(e);
      ctx.lineTo(x, y);
      ctx.stroke();
      markDrawn();
    }

    function onUp(e: React.PointerEvent<HTMLCanvasElement>) {
      drawingRef.current = false;
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        /* already released */
      }
    }

    function clear() {
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext('2d');
      if (canvas && ctx) {
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.restore();
      }
      emptyRef.current = true;
      setEmpty(true);
    }

    useImperativeHandle(ref, () => ({
      toDataURL() {
        if (emptyRef.current || !canvasRef.current) return null;
        try {
          return canvasRef.current.toDataURL('image/png');
        } catch {
          return null;
        }
      },
      clear,
      isEmpty: () => emptyRef.current,
    }));

    return (
      <div className="sig-box" ref={boxRef} style={{ height }}>
        <canvas
          ref={canvasRef}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
          aria-label="Signature pad"
        />
        {!empty && (
          <button type="button" className="sig-clear" onClick={clear}>
            <Eraser size={12} /> Clear
          </button>
        )}
      </div>
    );
  }
);
