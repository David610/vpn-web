import { describe, it, expect } from "vitest";
import { buildNodeBootstrapUserData, BOOTSTRAP_SCRIPT, AGENT_UNIT } from "../node-bootstrap.js";

const valid = {
  workerUrl: "https://arcana.example.test",
  nodeId: "de-fsn-001",
  role: "EXIT",
  hostname: "de-fsn-001.nodes.example.test",
  enrollmentToken: "0123456789abcdef".repeat(4),
  singboxVpnVersion: "v1.1.0-rc.2",
};

describe("buildNodeBootstrapUserData", () => {
  it("writes the env file 0600, the script 0700, and starts the resumable bootstrap unit", () => {
    const ud = buildNodeBootstrapUserData(valid);
    expect(ud.startsWith("#cloud-config\n")).toBe(true);
    expect(ud).toMatch(/path: \/etc\/arcana\/bootstrap\.env\n {4}owner: root:root\n {4}permissions: '0600'/);
    expect(ud).toMatch(/path: \/usr\/local\/sbin\/arcana-node-bootstrap\n {4}owner: root:root\n {4}permissions: '0700'/);
    expect(ud).toContain("[systemctl, enable, arcana-node-bootstrap.service]");
    expect(ud).toContain("NODE_ROLE=exit");
    expect(ud).toContain(`ENROLLMENT_TOKEN=${valid.enrollmentToken}`);
  });

  it("puts the token only in the 0600 env file -- never in a URL or a command line", () => {
    const ud = buildNodeBootstrapUserData(valid);
    expect(ud.split(valid.enrollmentToken).length - 1).toBe(1);
    expect(ud).not.toMatch(/runcmd:[\s\S]*[0-9a-f]{64}/);
  });

  it("embeds the agent unit and never sends secrets in argv (curl reads them from header files)", () => {
    const ud = buildNodeBootstrapUserData(valid);
    expect(ud).toContain("ExecStart=/usr/local/bin/vpn-provisioning-agent --config /etc/vpn/provisioning-agent.toml");
    expect(BOOTSTRAP_SCRIPT).not.toMatch(/-H "Authorization/);
    expect(BOOTSTRAP_SCRIPT).toMatch(/-H @"\$hdr"/);
    expect(AGENT_UNIT).toMatch(/ConditionPathExists=\/etc\/vpn\/provisioning-agent\.toml/);
  });

  it("persists the node key BEFORE enrolling, and only ever sends its hash", () => {
    const writeKey = BOOTSTRAP_SCRIPT.indexOf("write_agent_config \"$(od");
    const enrollCall = BOOTSTRAP_SCRIPT.indexOf("/api/agent/enroll");
    expect(writeKey).toBeGreaterThan(0);
    expect(enrollCall).toBeGreaterThan(writeKey);
    expect(BOOTSTRAP_SCRIPT).toContain('\\"apiKeySha256\\":\\"$hash\\"');
    expect(BOOTSTRAP_SCRIPT).toContain("sed -i '/^ENROLLMENT_TOKEN=/d'");
  });

  it.each([
    ["workerUrl", "http://arcana.example.test"],
    ["workerUrl", "https://arcana.example.test/?x=1"],
    ["nodeId", "DE FSN; rm -rf /"],
    ["role", "exit"],
    ["hostname", "de-fsn-001.nodes.example.test;id"],
    ["hostname", "$(id).example.test"],
    ["enrollmentToken", "not-hex"],
    ["singboxVpnVersion", "main"],
    ["singboxVpnVersion", "v1.0.0;curl evil"],
    ["singboxVpnRepo", "evil repo"],
  ])("rejects an unsafe %s (%s) instead of templating it into a root shell script", (field, value) => {
    expect(() => buildNodeBootstrapUserData({ ...valid, [field]: value })).toThrow(/node bootstrap/);
  });
});
