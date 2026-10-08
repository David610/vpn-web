"use client";

import { AccountShell } from "@/components/account/AccountShell";
import HelpCenter from "@/components/HelpCenter";

export default function AccountHelpPage() {
  return (
    <AccountShell title="Help" sub="Find answers and get support.">
      <HelpCenter />
    </AccountShell>
  );
}
