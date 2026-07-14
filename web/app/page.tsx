import { redirect } from 'next/navigation';

// The merchant is the only one who starts at the root; customers arrive at /pay/[id]
// via QR. Send the root straight to the dashboard, which gates to sign-in itself.
export default function Home() {
  redirect('/dashboard');
}
