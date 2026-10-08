"use client";

import { AccountShell, useAccount } from "@/components/account/AccountShell";
import { TelegramCard } from "@/components/TelegramCard";

function TelegramBody() {
  const { session } = useAccount();
  return <TelegramCard session={session} />;
}

export default function AccountTelegramPage() {
  return (
    <AccountShell title="Telegram" sub="Manage your VPN links from Telegram." narrow>
      <TelegramBody />
    </AccountShell>
  );
}
