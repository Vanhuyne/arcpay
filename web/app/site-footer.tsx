import { addressUrl } from '@/lib/arc';
import { FORWARDER_ADDRESS } from '@/lib/forwarder';
import { ROUTER_ADDRESS } from '@/lib/router';

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <p>ArcPay · runs on Arc Testnet</p>
      <nav>
        <a href={addressUrl(ROUTER_ADDRESS)} target="_blank" rel="noreferrer">
          PaymentRouter
        </a>
        <a href={addressUrl(FORWARDER_ADDRESS)} target="_blank" rel="noreferrer">
          CrossPayForwarder
        </a>
        <a href="https://github.com/Vanhuyne/arcpay" target="_blank" rel="noreferrer">
          GitHub
        </a>
      </nav>
    </footer>
  );
}
