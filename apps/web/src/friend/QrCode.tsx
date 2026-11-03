import QRCode from 'qrcode';
import { useEffect, useState } from 'react';

/** A QR code for `value`, drawn as an inline SVG so it stays sharp and needs no image file. */
export function QrCode({ value, label }: { value: string; label: string }) {
  const [svg, setSvg] = useState<string>('');
  useEffect(() => {
    let cancelled = false;
    void QRCode.toString(value, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }).then((s) => {
      if (!cancelled) setSvg(s);
    });
    return () => {
      cancelled = true;
    };
  }, [value]);
  if (!svg) return <div className="size-40" aria-hidden="true" />;
  return (
    <div
      role="img"
      aria-label={label}
      className="size-40 rounded-lg bg-white p-1 [&>svg]:size-full"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
