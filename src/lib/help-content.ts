import { PLAN_DEVICES, PLAN_PRICE_LABEL, TWO_SERVER_LINKS } from "./site-config";

export type HelpCategory = { id: string; label: string; icon: "book" | "laptop" | "globe" | "card" | "shield" | "wrench" };
export type HelpItem = { category: string; question: string; summary: string; answer: string[] };

export const HELP_CATEGORIES: HelpCategory[] = [
  { id: "getting-started", label: "Getting started", icon: "book" },
  { id: "links", label: "Using your link", icon: "laptop" },
  { id: "locations", label: "Locations and servers", icon: "globe" },
  { id: "billing", label: "Billing and account", icon: "card" },
  { id: "privacy", label: "Privacy and security", icon: "shield" },
  { id: "troubleshooting", label: "Troubleshooting", icon: "wrench" },
];

const TWO_SERVERS: HelpItem = TWO_SERVER_LINKS
  ? {
      category: "locations",
      question: "How do I use two servers?",
      summary: "Route a link through two servers for extra privacy.",
      answer: [
        "When you create or edit a link, choose 2 servers under Routing. Your traffic then passes through two locations instead of one, which adds a layer of privacy and may reduce speed.",
        "If a two-server route is not available, Arcana tells you. It never quietly gives you a single server instead.",
      ],
    }
  : {
      category: "locations",
      question: "Can I use two servers?",
      summary: "Not yet for third-party VPN clients.",
      answer: [
        "Two-server routing needs a VPN client that can chain two connections, and the clients Arcana links support today connect through one server. Your links use a single server for now.",
        "When two-server routing becomes available it will appear as an option when you create or edit a link.",
      ],
    };

export const HELP_ITEMS: HelpItem[] = [
  {
    category: "getting-started",
    question: "What is Arcana?",
    summary: "Private VPN access through secure links.",
    answer: [
      "Arcana gives you private VPN access through secure HTTPS links. You paste a link into a compatible third-party VPN client. There is no Arcana app to install.",
      `One plan covers up to ${PLAN_DEVICES} devices. Your subscription and your links are managed from your account.`,
    ],
  },
  {
    category: "getting-started",
    question: "How does Arcana work?",
    summary: "Understand how we route your traffic.",
    answer: [
      "Your VPN client connects through an Arcana server, so the sites you visit see the server's address instead of yours.",
      "Your account and payment details are kept separate from the connection credentials inside your link.",
    ],
  },
  {
    category: "getting-started",
    question: "How do I get started?",
    summary: "Create an account, make a link, paste it into a client.",
    answer: [
      "Create an account and subscribe. Then open VPN links, choose Create link, pick your settings and copy the link.",
      "Paste the link into a compatible VPN client as a subscription or configuration link, then connect from that client.",
    ],
  },
  {
    category: "getting-started",
    question: "How do I cancel my plan?",
    summary: "Find out how to manage your subscription and cancel anytime.",
    answer: [
      "Sign in and open Account & plan. From there you can cancel, and your access continues until the end of the period you have paid for.",
    ],
  },
  {
    category: "links",
    question: "Which VPN clients can I use?",
    summary: "Clients that accept an HTTPS subscription link.",
    answer: [
      "Arcana links work with clients that import a subscription link for VLESS or Hysteria2 connections, such as Hiddify, Shadowrocket, Incy, sing-box and Xray-based clients.",
      "Arcana cannot promise compatibility with every client. If yours does not accept the link, try one of these.",
    ],
  },
  {
    category: "links",
    question: "Who can use my link?",
    summary: "Anyone who has it. Keep it private.",
    answer: [
      "Anyone with your link can connect with it, so treat it like a password and do not post or share it.",
      "If a link was shared or lost, open it and replace it. The old link stops working immediately.",
    ],
  },
  {
    category: "links",
    question: "How do I revoke a link?",
    summary: "Open the link and choose Revoke link.",
    answer: [
      "Open VPN links, choose the link and select Revoke link. Anything still using it stops working, and it no longer uses one of your device places.",
    ],
  },
  {
    category: "locations",
    question: "Which locations can I connect to?",
    summary: "Only locations with a server running right now are offered.",
    answer: ["Choose Location when you create a link. The list only shows locations that have a server available right now."],
  },
  {
    category: "locations",
    question: "What does Automatic do?",
    summary: "Arcana selects an available location for you.",
    answer: ["With Automatic, Arcana selects an available location for you. Choose a location yourself when you need your traffic to appear from there."],
  },
  TWO_SERVERS,
  {
    category: "billing",
    question: "How much does Arcana cost?",
    summary: `One plan: ${PLAN_PRICE_LABEL} a month for up to ${PLAN_DEVICES} devices.`,
    answer: [`There is a single plan at ${PLAN_PRICE_LABEL} a month that covers up to ${PLAN_DEVICES} devices. You can see and manage it under Account & plan.`],
  },
  {
    category: "billing",
    question: "How do I free up a device place?",
    summary: "Revoke a link you no longer use.",
    answer: ["Each active link uses one of your device places. Revoke a link you no longer use and its place is free again."],
  },
  {
    category: "privacy",
    question: "What does Arcana know about me?",
    summary: "Only what is needed to run your account.",
    answer: [
      "An email address to sign you in, your subscription status, and the name and settings of your links, including when each link last fetched its configuration.",
      "We do not ask for your name, address or payment details beyond what the payment provider needs to process your subscription. We do not log the sites you visit.",
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
    question: "My link will not connect",
    summary: "A few things to try first.",
    answer: [
      "Check that your subscription is active and that your internet works without the VPN. Then try a different location or network, and make sure your VPN client supports VLESS or Hysteria2 links.",
      "If it still fails, replace the link and import the new one. If that does not help, contact support and tell us the time, your VPN client and the location you chose. Please do not send passwords or links.",
    ],
  },
];
