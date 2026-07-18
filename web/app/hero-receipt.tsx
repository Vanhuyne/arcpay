/** Decorative hero: a receipt printing, a QR appearing, PAID landing. CSS-only. */
export function HeroReceipt() {
  return (
    <div className="receipt hero-receipt" aria-hidden>
      <p className="eyebrow hr-item hr-i1">ArcPay · point of sale</p>
      <div className="perf hr-item hr-i1" />
      <p className="hr-desc hr-item hr-i2">Two coffees</p>
      <p className="amount hr-item hr-i2">
        5.00<span className="unit">USDC</span>
      </p>
      <svg className="hr-qr hr-item hr-i3" viewBox="0 0 7 7" role="presentation">
        <rect x="0" y="0" width="3" height="3" fill="none" stroke="currentColor" strokeWidth="0.6" />
        <rect x="1" y="1" width="1" height="1" />
        <rect x="4" y="0" width="3" height="3" fill="none" stroke="currentColor" strokeWidth="0.6" />
        <rect x="5" y="1" width="1" height="1" />
        <rect x="0" y="4" width="3" height="3" fill="none" stroke="currentColor" strokeWidth="0.6" />
        <rect x="1" y="5" width="1" height="1" />
        <rect x="4" y="4" width="1" height="1" />
        <rect x="6" y="4" width="1" height="1" />
        <rect x="5" y="5" width="1" height="1" />
        <rect x="4" y="6" width="1" height="1" />
        <rect x="6" y="6" width="1" height="1" />
      </svg>
      <div className="stamp hr-stamp">PAID</div>
      <p className="hr-time">settled in 0.77s</p>
    </div>
  );
}
