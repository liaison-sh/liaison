// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Builds timestamp replies openssl refuses to make (a non-critical usage, a
// wrong content type, another imprint algorithm), signed with a fixture
// key through pkijs. Test use only. `forgeReply` with no change yields a reply
// the verifier accepts, so each refusal test changes exactly one thing.
import { createHash, webcrypto } from "node:crypto"
import { readFileSync } from "node:fs"
import * as asn1js from "asn1js"
import * as pkijs from "pkijs"
import {
  OID_ATTR_CONTENT_TYPE,
  OID_ATTR_MESSAGE_DIGEST,
  OID_ATTR_SIGNING_CERTIFICATE_V2,
  OID_CT_TSTINFO,
  OID_SHA256,
  OID_SIGNED_DATA,
} from "~/modules/signing/constants"
import type { IssuedCert } from "~/modules/signing/test-fixtures/tsa/authority"

async function importKey(keyPath: string): Promise<CryptoKey> {
  const pem = readFileSync(keyPath, "utf8")
  const der = Buffer.from(pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, ""), "base64")
  return webcrypto.subtle.importKey(
    "pkcs8",
    der,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  ) as Promise<CryptoKey>
}

export interface ForgeOptions {
  signer: IssuedCert
  seal: Uint8Array
  nonce: bigint
  genTime: Date
  imprintAlgorithm?: string
  eContentType?: string
  /** Certificates the token carries (default: the signer's). */
  certificates?: pkijs.Certificate[]
  /** The certificate the ESS attribute names (default: the signer's). */
  essNames?: pkijs.Certificate
  /** The signed content-type attribute's value (default: the eContentType). */
  contentTypeAttribute?: string
}

export async function forgeReply(o: ForgeOptions): Promise<Uint8Array> {
  const tst = new pkijs.TSTInfo({
    version: 1,
    policy: "1.3.6.1.4.1.55555.1.1",
    messageImprint: new pkijs.MessageImprint({
      hashAlgorithm: new pkijs.AlgorithmIdentifier({
        algorithmId: o.imprintAlgorithm ?? OID_SHA256,
        algorithmParams: new asn1js.Null(),
      }),
      hashedMessage: new asn1js.OctetString({ valueHex: o.seal }),
    }),
    serialNumber: asn1js.Integer.fromBigInt(42n),
    genTime: o.genTime,
    nonce: asn1js.Integer.fromBigInt(o.nonce),
  })
  const tstDer = new Uint8Array(tst.toSchema().toBER(false))
  const certDer = new Uint8Array((o.essNames ?? o.signer.cert).toSchema().toBER(false))
  const essCertIdV2 = new asn1js.Sequence({
    value: [
      new asn1js.Sequence({
        value: [
          new asn1js.Sequence({
            value: [
              new asn1js.OctetString({
                valueHex: createHash("sha256").update(certDer).digest(),
              }),
            ],
          }),
        ],
      }),
    ],
  })
  const eContentType = o.eContentType ?? OID_CT_TSTINFO
  const signed = new pkijs.SignedData({
    version: 3,
    encapContentInfo: new pkijs.EncapsulatedContentInfo({
      eContentType,
      eContent: new asn1js.OctetString({ valueHex: tstDer }),
    }),
    signerInfos: [
      new pkijs.SignerInfo({
        version: 1,
        sid: new pkijs.IssuerAndSerialNumber({
          issuer: o.signer.cert.issuer,
          serialNumber: o.signer.cert.serialNumber,
        }),
        signedAttrs: new pkijs.SignedAndUnsignedAttributes({
          type: 0,
          attributes: [
            new pkijs.Attribute({
              type: OID_ATTR_CONTENT_TYPE,
              values: [
                new asn1js.ObjectIdentifier({ value: o.contentTypeAttribute ?? eContentType }),
              ],
            }),
            new pkijs.Attribute({
              type: OID_ATTR_MESSAGE_DIGEST,
              values: [
                new asn1js.OctetString({
                  valueHex: createHash("sha256").update(tstDer).digest(),
                }),
              ],
            }),
            new pkijs.Attribute({
              type: OID_ATTR_SIGNING_CERTIFICATE_V2,
              values: [essCertIdV2],
            }),
          ],
        }),
      }),
    ],
    certificates: o.certificates ?? [o.signer.cert],
  })
  // DER, as openssl writes it: the library's constructor splits eContent into a
  // constructed string, which its own TSTInfo check then cannot read.
  signed.encapContentInfo.eContent = new asn1js.OctetString({ valueHex: tstDer })
  await signed.sign(await importKey(o.signer.keyPath), 0, "SHA-256")
  const resp = new pkijs.TimeStampResp({
    status: new pkijs.PKIStatusInfo({ status: pkijs.PKIStatus.granted }),
    timeStampToken: new pkijs.ContentInfo({
      contentType: OID_SIGNED_DATA,
      content: signed.toSchema(true),
    }),
  })
  return new Uint8Array(resp.toSchema().toBER(false))
}
