/**
 * A registration plate shown exactly in the order it is written ("12345-أ-6").
 * Without isolation the browser's bidi algorithm treats "أ-6" as Arabic text and displays
 * "12345-6-أ", which is a different plate to the reader. Each part is isolated left-to-right.
 */
export function Plate({ value, large = false }: { value: string; large?: boolean }) {
  const parts = value.split(/([\s|/\-–]+)/).filter((p) => p !== '');
  return (
    <span className={`plate${large ? ' plate-lg' : ''}`} dir="ltr" translate="no">
      {parts.map((p, i) =>
        /^[\s|/\-–]+$/.test(p) ? (
          <span key={i} className="plate-sep" aria-hidden="true">
            -
          </span>
        ) : (
          <bdi key={i} dir={/[؀-ۿ]/.test(p) ? 'rtl' : 'ltr'}>
            {p}
          </bdi>
        ),
      )}
    </span>
  );
}
