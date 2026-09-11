import { describe, expect, it, vi } from "vitest";
import { runSaleRetention } from "./sale-retention";

function clientFor(removeError: string | null = null) {
  const rpc = vi
    .fn()
    .mockResolvedValue({ data: { deleted: 1, remaining: 0, busy: false }, error: null });
  const ack = vi.fn().mockResolvedValue({ error: null, data: null });
  const remove = vi
    .fn()
    .mockResolvedValue({ error: removeError ? { message: removeError } : null, data: [] });
  const client = {
    rpc,
    from: vi.fn(() => ({
      select: () => ({
        order: () => ({
          limit: async () => ({
            error: null,
            data: [
              { id: "job", bucket: "information-agent-evidence", object_path: "sale/file.pdf" },
            ],
          }),
        }),
      }),
      delete: () => ({ eq: ack }),
    })),
    storage: { from: vi.fn(() => ({ remove })) },
  };
  return { client, rpc, ack, remove };
}
describe("sale retention", () => {
  it("removes storage then acknowledges durable work", async () => {
    const { client, ack, remove } = clientFor();
    expect(await runSaleRetention(new Date("2026-09-11T12:00:00Z"), client)).toMatchObject({
      deleted: 1,
      filesDeleted: 1,
    });
    expect(remove).toHaveBeenCalledWith(["sale/file.pdf"]);
    expect(ack).toHaveBeenCalledWith("id", "job");
    expect(remove.mock.invocationCallOrder[0]).toBeLessThan(ack.mock.invocationCallOrder[0]);
  });
  it("keeps retry work when storage fails", async () => {
    const { client, ack } = clientFor("unavailable");
    await expect(runSaleRetention(new Date(), client)).rejects.toThrow("unavailable");
    expect(ack).not.toHaveBeenCalled();
  });
  it("propagates database failures before any storage deletion", async () => {
    const { client, rpc, remove } = clientFor();
    rpc.mockResolvedValueOnce({ data: null, error: { message: "bridge failed" } });
    await expect(runSaleRetention(new Date(), client)).rejects.toThrow("bridge failed");
    expect(remove).not.toHaveBeenCalled();
  });
  it("stops on concurrent purge and still drains committed file removals", async () => {
    const { client, rpc } = clientFor();
    rpc.mockResolvedValueOnce({ data: { deleted: 0, remaining: null, busy: true }, error: null });
    expect(await runSaleRetention(new Date(), client)).toMatchObject({
      busy: true,
      filesDeleted: 1,
    });
    expect(rpc).toHaveBeenCalledTimes(1);
  });
});
