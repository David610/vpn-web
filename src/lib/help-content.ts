export type HelpCategory = { id: string; label: string; icon: "book" | "laptop" | "globe" | "card" | "shield" | "wrench" };
export type HelpItem = { category: string; question: string; summary: string; answer: string[] };

export const HELP_CATEGORIES: HelpCategory[] = [
  { id: "getting-started", label: "Getting started", icon: "book" },
  { id: "apps", label: "Using the apps", icon: "laptop" },
  { id: "locations", label: "Locations and servers", icon: "globe" },
  { id: "billing", label: "Billing and account", icon: "card" },
  { id: "privacy", label: "Privacy and security", icon: "shield" },
  { id: "troubleshooting", label: "Troubleshooting", icon: "wrench" },
];

export const HELP_ITEMS: HelpItem[] = [
  {
    category: "getting-started",
    question: "What is Arcana?",
    summary: "Learn what Arcana is, and how it helps you access a more open internet.",
    answer: [
      "Arcana is private VPN access without the clutter. One plan covers up to three of your devices, and you connect with one tap.",
      "Your subscription, your devices and your connection links are all managed from your account.",
    ],
  },
  {
    category: "getting-started",
    question: "How does Arcana work?",
    summary: "Understand how we encrypt your connection and route your traffic.",
    answer: [
      "The app encrypts your traffic and sends it through an Arcana server, so the sites you visit see the server's address instead of yours.",
      "Your account and payment details are kept separate from the credentials your device uses to connect. Those connection credentials are short-lived and are renewed automatically.",
    ],
  },
  {
    category: "getting-started",
    question: "How do I install the app?",
    summary: "Step-by-step instructions for the platforms we support.",
    answer: [
      "Create an account, then open the Apps page and download the app for your device. Sign in with the same account and tap Connect.",
      "The Windows app is first. The other platforms are in preparation and are marked as coming soon on the Apps page.",
    ],
  },
  {
    category: "getting-started",
    question: "How do I use two servers?",
    summary: "Learn how to connect using one or two servers for extra privacy.",
    answer: [
      "In the app, open Route and choose Two servers. Your traffic then passes through two locations instead of one, which adds a layer of privacy and may reduce speed.",
      "If a two-server route is not available, Arcana tells you. It never quietly connects through a single server instead.",
    ],
  },
  {
    category: "getting-started",
    question: "How do I cancel my plan?",
    summary: "Find out how to manage your subscription and cancel anytime.",
    answer: [
      "Sign in, open Account, then Subscription. From there you can cancel, and your access continues until the end of the period you have paid for.",
    ],
  },
  {
    category: "apps",
    question: "How do I connect and disconnect?",
    summary: "The power button on the Home screen does both.",
    answer: [
      "Tap the power button on Home to connect. The screen shows Connecting while the route is set up, then Protected once it is private. Tap it again to disconnect.",
    ],
  },
  {
    category: "apps",
    question: "What does “Internet blocked” mean?",
    summary: "The kill switch is holding traffic until the connection is back.",
    answer: [
      "If the connection drops unexpectedly, the app blocks internet access instead of letting traffic leave unprotected. It reconnects automatically. You can disconnect on purpose from Home to restore normal access.",
    ],
  },
  {
    category: "locations",
    question: "Which locations can I connect to?",
    summary: "Only locations with a server running right now are listed.",
    answer: ["Open Locations to see every place you can connect today. The list only shows locations that have a server running right now."],
  },
  {
    category: "locations",
    question: "What does Automatic do?",
    summary: "It picks the best location for you.",
    answer: ["Automatic chooses the fastest, most reliable server for your location and network conditions. Pick a specific location instead when you need your traffic to appear from there."],
  },
  {
    category: "billing",
    question: "How much does Arcana cost?",
    summary: "One plan: €6.99 a month for up to 3 devices.",
    answer: ["There is a single plan at €6.99 a month that covers up to three devices. You can see and change your subscription under Account, Subscription."],
  },
  {
    category: "billing",
    question: "How do I remove a device?",
    summary: "Free a seat from your account.",
    answer: ["Open Account, then Devices, and remove the device you no longer use. Its connection credentials stop working and the seat is free again."],
  },
  {
    category: "privacy",
    question: "What does Arcana know about me?",
    summary: "Only what is needed to run your account.",
    answer: [
      "An email address to sign you in, your subscription status, and basic details about the devices you register, such as their name, platform and when they last connected.",
      "We do not ask for your name, address or payment details beyond what the payment provider needs to process your subscription.",
    ],
  },
  {
    category: "privacy",
    question: "Does a VPN make me anonymous?",
    summary: "No — it protects your connection, not your identity.",
    answer: ["A VPN hides your IP address and encrypts your traffic. Websites and services can still identify you through your account, cookies or other data."],
  },
  {
    category: "troubleshooting",
    question: "The app will not connect",
    summary: "A few things to try first.",
    answer: [
      "Check that your internet works without the VPN, then try a different location. If your network blocks VPN traffic, try again on another network.",
      "If it still fails, contact support and tell us the time, your platform and the location you chose. Please do not send passwords or connection links.",
    ],
  },
];
