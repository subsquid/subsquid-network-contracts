import testLog from "./data/test_log.json" assert { type: "json" };
import {
  populateQueryProto,
  validateSignatures,
  verifySignature,
} from "../src/signatureVerification";
import { expect } from "chai";

describe("Signature verification", () => {
  it("populateQueryProto returns buffer", async () => {
    const populated = await populateQueryProto(testLog);
    expect(populated).to.be.instanceOf(Uint8Array);
    expect(populated.length).to.equal(135);
  });

  it("verifySignature returns true for correct signature", async () => {
    const message = await populateQueryProto(testLog);
    expect(
      verifySignature(message, testLog.client_signature, testLog.client_id),
    ).to.be.true;
  });

  it("verifySignature returns false for incorrect signature", async () => {
    const message = await populateQueryProto(testLog);
    expect(
      verifySignature(message, testLog.client_signature, testLog.worker_id),
    ).to.be.false;
  });

  it("verifySignatures returns true for correct query object", async () => {
    expect(await validateSignatures(testLog)).to.be.true;
  });
});
