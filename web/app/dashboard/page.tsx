import { readSession } from '@/lib/session';
import { Dashboard } from './dashboard';
import { SignIn } from './sign-in';

export default async function DashboardPage() {
  const merchant = await readSession();
  if (!merchant) return <SignIn />;
  return <Dashboard merchant={merchant} />;
}
