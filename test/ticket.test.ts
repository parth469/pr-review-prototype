import { describe, expect, it } from "vitest";
import {
  buildTicketContext,
  cleanDescription,
  loadTicket,
  parseLinkback,
  pickTickets,
  type TicketContext,
  ticketIdFromBranch,
  ticketNote,
} from "../src/ticket.ts";
import { makePr, silentLog } from "./helpers.ts";

// Made-up tickets in the layout Linear's GitHub app uses for its linkback comment.
function details(id: string, title: string, description: string): string {
  return [
    "<details>",
    `<summary><a href="https://linear.app/acme/issue/${id}/some-slug">${id} ${title}</a></summary>`,
    "<p>",
    "",
    description,
    "</p>",
    "</details>",
  ].join("\n");
}

function linkback(...blocks: string[]): string {
  return [
    "<!-- linear-linkback -->",
    ...blocks,
    "<!-- linear-review-link -->",
    '<p><a href="https://linear.app/acme/review/x">Review in Linear</a></p>',
  ].join("\n");
}

const STORY = `## Goal

Let a team admin export the member list as CSV, so audits need no manual copying.

## Acceptance Criteria

### Export

* The members page has an Export button for admins.
* The file lists name, email and role.

\`\`\`
name,email,role
\`\`\`

## Out of Scope

* Exporting graphs. Related: [ACME-7](https://linear.app/acme/issue/ACME-7/x)`;

const EMPTY_BUG = `## Bug Description

Clear description of the issue.

## Steps to Reproduce

1. Step 1
2. Step 2
3. Step 3

## Expected Behavior

What should happen.

## Actual Behavior

What actually happens.

## Environment

* Browser/Device:
* OS:
* Version:

## Screenshots/Logs

\\[Attach relevant screenshots or error logs\\]

## Developer Checklist

- [ ] Root cause identified
- [ ] Fix implemented
- [ ] Regression tests added
- [ ] Existing tests still pass
- [ ] Related areas tested for side effects
- [ ] Documentation updated if needed`;

describe("parseLinkback", () => {
  it("reads every linked ticket with its markdown description", () => {
    const tickets = parseLinkback(
      linkback(
        details("ACME-12", "Export members as CSV", STORY),
        details("ACME-13", "Fix &quot;Export&quot; label", "Short."),
      ),
    );
    expect(tickets.map((t) => [t.id, t.title])).toEqual([
      ["ACME-12", "Export members as CSV"],
      ["ACME-13", 'Fix "Export" label'],
    ]);
    expect(tickets[0]?.url).toBe("https://linear.app/acme/issue/ACME-12/some-slug");
    expect(tickets[0]?.description).toBe(STORY);
  });

  it("ignores any other comment", () => {
    expect(parseLinkback(details("ACME-12", "x", "y"))).toEqual([]);
    expect(parseLinkback("Fixes ACME-12")).toEqual([]);
  });

  it("keeps a ticket whose title is hidden (private team)", () => {
    const body = linkback(
      '<details>\n<summary><a href="https://linear.app/acme/issue/ACME-9/x">ACME-9</a></summary>\n<p>\n\nText.\n</p>\n</details>',
    );
    expect(parseLinkback(body)).toEqual([
      {
        id: "ACME-9",
        title: "",
        url: "https://linear.app/acme/issue/ACME-9/x",
        description: "Text.",
      },
    ]);
  });
});

describe("ticketIdFromBranch", () => {
  it.each([
    ["parth/kgit-1316-story-as-a-team", "KGIT-1316"],
    ["KGIT-42", "KGIT-42"],
    ["heta/kgit-1262-search-name-scope", "KGIT-1262"],
    ["parth/purge-fix", undefined],
    ["cycle-14", "CYCLE-14"],
  ])("%s -> %s", (ref, id) => {
    expect(ticketIdFromBranch(ref)).toBe(id);
  });
});

describe("pickTickets", () => {
  it("puts the branch's ticket first and keeps the rest in order", () => {
    const linked = [{ id: "ACME-1" }, { id: "ACME-2" }, { id: "ACME-3" }];
    expect(pickTickets(linked, "me/acme-2-thing").map((t) => t.id)).toEqual([
      "ACME-2",
      "ACME-1",
      "ACME-3",
    ]);
    expect(pickTickets(linked, "me/no-id").map((t) => t.id)).toEqual([
      "ACME-1",
      "ACME-2",
      "ACME-3",
    ]);
  });
});

describe("cleanDescription", () => {
  it("treats an unfilled bug template as title only", () => {
    expect(cleanDescription(EMPTY_BUG)).toEqual({ text: "", templateOnly: true });
  });

  it("keeps what was filled in and drops the untouched template lines", () => {
    const filled = EMPTY_BUG.replace(
      "Clear description of the issue.",
      "Viewers see the Create graph button and get an error when they press it.",
    );
    const { text, templateOnly } = cleanDescription(filled);
    expect(templateOnly).toBe(false);
    expect(text).toBe(
      "## Bug Description\n\nViewers see the Create graph button and get an error when they press it.",
    );
  });

  it("knows the template in the checkbox spelling of Linear's comment, ticked or not", () => {
    const asCommented = EMPTY_BUG.replace(/- \[ \] Root/, "- ☑ Root").replace(/- \[ \] /g, "- ☐ ");
    expect(cleanDescription(asCommented)).toEqual({ text: "", templateOnly: true });
  });

  it("keeps a real ticket whole, nested headings included", () => {
    expect(cleanDescription(STORY)).toEqual({ text: STORY, templateOnly: false });
  });
});

describe("buildTicketContext", () => {
  const linked = [
    {
      id: "ACME-1",
      title: "Other",
      url: "u1",
      description: "Some other ticket text that is long enough to keep.",
    },
    { id: "ACME-12", title: "Export", url: "u12", description: STORY },
  ];

  it("returns nothing without tickets", () => {
    expect(buildTicketContext([], "me/acme-12", 8000)).toBeUndefined();
  });

  it("puts the branch's ticket first and keeps everything when it fits", () => {
    const ctx = buildTicketContext(linked, "me/acme-12-export", 8000);
    expect(ctx?.truncated).toBe(false);
    expect(ctx?.tickets.map((t) => t.id)).toEqual(["ACME-12", "ACME-1"]);
    expect(ctx?.tickets[0]?.description).toBe(STORY);
  });

  it("gives the room the first ticket leaves to the next ones", () => {
    const big = {
      id: "ACME-2",
      title: "Big",
      url: "u2",
      description: `## Goal\n\n${"y".repeat(900)}`,
    };
    const ctx = buildTicketContext(
      [linked[1] as (typeof linked)[number], big],
      "me/acme-12",
      STORY.length + 500,
    );
    expect(ctx?.truncated).toBe(true);
    expect(ctx?.tickets[0]?.description).toBe(STORY);
    // No section fits whole in the ~500 left, so it is cut there.
    expect(ctx?.tickets[1]?.description.length).toBeLessThanOrEqual(500);
    expect(ctx?.tickets[1]?.description).toMatch(/^## Goal\n\ny+…$/);
  });

  it("cuts down to the key sections and drops other tickets' text when too long", () => {
    const long = `${STORY}\n\n## Notes\n\n${"x".repeat(400)}`;
    const ctx = buildTicketContext(
      [
        { ...linked[1], description: long } as (typeof linked)[number],
        linked[0] as (typeof linked)[number],
      ],
      "me/acme-12",
      STORY.length + 10,
    );
    expect(ctx?.truncated).toBe(true);
    expect(ctx?.tickets[0]?.description).toContain("## Goal");
    expect(ctx?.tickets[0]?.description).toContain("## Out of Scope");
    expect(ctx?.tickets[0]?.description).not.toContain("## Notes");
    expect(ctx?.tickets[1]).toMatchObject({ id: "ACME-1", description: "" });
  });
});

describe("loadTicket", () => {
  function memoryStore() {
    const rows = new Map<string, TicketContext>();
    return {
      rows,
      getTicket: (repo: string, pr: number) => rows.get(`${repo}#${pr}`),
      saveTicket: (repo: string, pr: number, t: TicketContext) => {
        rows.set(`${repo}#${pr}`, t);
      },
    };
  }

  it("reads Linear's comment once, saves it, and reuses it", async () => {
    const store = memoryStore();
    let calls = 0;
    const source = {
      listIssueComments: async () => {
        calls++;
        return [
          { author: "someone", body: linkback(details("ACME-99", "Fake", STORY)), createdAt: "" },
          {
            author: "linear-code[bot]",
            body: linkback(details("ACME-12", "Export", STORY)),
            createdAt: "",
          },
        ];
      },
    };
    const pr = makePr({ headRef: "me/acme-12-export" });
    const first = await loadTicket({ source, store, log: silentLog }, pr, 8000);
    expect(first?.tickets.map((t) => t.id)).toEqual(["ACME-12"]);
    const again = await loadTicket({ source, store, log: silentLog }, pr, 8000);
    expect(again).toEqual(first);
    expect(calls).toBe(1);
  });

  it("saves nothing when no ticket is linked, so the next round looks again", async () => {
    const store = memoryStore();
    const source = { listIssueComments: async () => [] };
    expect(await loadTicket({ source, store, log: silentLog }, makePr(), 8000)).toBeUndefined();
    expect(store.rows.size).toBe(0);
  });

  it("goes on without a ticket when GitHub fails", async () => {
    const source = {
      listIssueComments: async () => {
        throw new Error("boom");
      },
    };
    expect(
      await loadTicket({ source, store: memoryStore(), log: silentLog }, makePr(), 8000),
    ).toBeUndefined();
  });
});

describe("ticketNote", () => {
  const ctx: TicketContext = {
    tickets: [{ id: "ACME-1", title: "x", url: "u", description: "", templateOnly: true }],
    truncated: false,
  };

  it("checks against the ticket in round 1 only", () => {
    expect(ticketNote(ctx, 1)).toContain("Check the change against it");
    expect(ticketNote(ctx, 2)).toContain("Do not raise findings about the ticket");
    expect(ticketNote(ctx, 2)).not.toContain("Check the change against it");
  });

  it("says when there is no ticket", () => {
    expect(ticketNote(undefined, 1)).toContain("No ticket is linked");
  });
});
