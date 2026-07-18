import { readSession } from '@/lib/session';
import { SiteHeader } from '../site-header';
import { Dashboard } from './dashboard';
import { SignIn } from './sign-in';

export default async function DashboardPage() {
  const merchant = await readSession();
  return (
    <div className="terminal-bg site">
      <SiteHeader />
      {merchant ? <Dashboard merchant={merchant} /> : <SignIn />}
    </div>
  );
}
