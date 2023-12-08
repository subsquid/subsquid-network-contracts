import testLog from "./data/test_log.json" assert { type: "json" };
import {
  populateQueryProto,
  validateSignatures,
  verifySignature,
} from "../src/signatureVerification";
import { expect } from "chai";

const [withDefaultValues, withoutDefaultValues] = testLog;

describe("Signature verification", () => {
  it("populateQueryProto returns buffer", async () => {
    const populated = await populateQueryProto(withDefaultValues);
    expect(populated).to.be.instanceOf(Uint8Array);
    expect(populated.length).to.equal(149);
  });

  it("verifySignature returns true for correct signature in log without default values", async () => {
    const message = await populateQueryProto(withoutDefaultValues);
    expect(
      verifySignature(
        message,
        withoutDefaultValues.client_signature,
        withoutDefaultValues.client_id,
      ),
    ).to.be.true;
  });

  it("verifySignature returns true for correct signature in withDefaultValues", async () => {
    const message = await populateQueryProto(withDefaultValues);
    expect(
      verifySignature(
        message,
        withDefaultValues.client_signature,
        withDefaultValues.client_id,
      ),
    ).to.be.true;
  });

  it("verifySignature returns false for incorrect signature", async () => {
    const message = await populateQueryProto(withDefaultValues);
    expect(
      verifySignature(
        message,
        withDefaultValues.client_signature,
        withDefaultValues.worker_id,
      ),
    ).to.be.false;
  });

  it("verifySignatures returns true for correct query object", async () => {
    expect(await validateSignatures(withDefaultValues)).to.be.true;
    expect(await validateSignatures(withoutDefaultValues)).to.be.true;
  });
});
