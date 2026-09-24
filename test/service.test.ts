import { describe, expect, it } from "vitest";
import { buildTaskXml, parseTaskList, TASK_NAME } from "../src/service.ts";

const xml = buildTaskXml({
  user: "PARTH\\Asus",
  nodePath: "C:\\Program Files\\nodejs\\node.exe",
  projectDir: "W:\\reivew-prototype",
  conhostPath: "C:\\Windows\\System32\\conhost.exe",
});

describe("buildTaskXml", () => {
  it("starts at your logon, as you, without admin rights", () => {
    expect(xml).toContain("<LogonTrigger>");
    expect(xml).toContain("<Delay>PT30S</Delay>");
    expect(xml.match(/<UserId>PARTH\\Asus<\/UserId>/g)).toHaveLength(2);
    expect(xml).toContain("<LogonType>InteractiveToken</LogonType>");
    expect(xml).toContain("<RunLevel>LeastPrivilege</RunLevel>");
  });

  it("runs the supervisor with no window and no time limit", () => {
    expect(xml).toContain("<Command>C:\\Windows\\System32\\conhost.exe</Command>");
    expect(xml).toMatch(
      /<Arguments>--headless "C:\\Program Files\\nodejs\\node\.exe" src[\\/]supervisor\.ts<\/Arguments>/,
    );
    expect(xml).toContain("<WorkingDirectory>W:\\reivew-prototype</WorkingDirectory>");
    expect(xml).toContain("<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>");
    expect(xml).toContain("<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>");
    expect(xml).toContain("<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>");
    expect(xml).toContain(`<URI>\\${TASK_NAME}</URI>`);
  });

  it("escapes values and keeps tags balanced", () => {
    const tricky = buildTaskXml({
      user: "A&B\\me",
      nodePath: "C:\\n<o>de.exe",
      projectDir: "W:\\x",
      conhostPath: "c.exe",
    });
    expect(tricky).toContain("<UserId>A&amp;B\\me</UserId>");
    expect(tricky).toContain("C:\\n&lt;o&gt;de.exe");
    const opened = (tricky.match(/<[A-Za-z]+[\s>]/g) ?? []).length;
    const closed = (tricky.match(/<\/[A-Za-z]+>/g) ?? []).length;
    expect(opened).toBe(closed);
  });
});

describe("parseTaskList", () => {
  it("reads schtasks /V /FO LIST output", () => {
    const out = [
      "",
      "Folder: \\",
      "HostName:                             PARTH",
      "TaskName:                             \\Proxy Reviewer",
      "Next Run Time:                        N/A",
      "Status:                               Running",
      "Last Run Time:                        24-09-2026 23:10:02",
      "Last Result:                          267009",
    ].join("\r\n");
    expect(parseTaskList(out)).toMatchObject({
      Status: "Running",
      "Last Run Time": "24-09-2026 23:10:02",
      "Last Result": "267009",
    });
  });
});
