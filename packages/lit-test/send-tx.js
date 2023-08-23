const {PKPEthersWallet} = require('@lit-protocol/pkp-ethers')
const { ZeroAddress } = require("ethers");
const {generateAuth} = require('./gen-auth-key')
async function sendExampleTx() {
    const authSig = await generateAuth();

    const pkpWallet = new PKPEthersWallet({
        controllerAuthSig: authSig,
        pkpPubKey: "0x044fa9ef12f20359d939dd94affecfaadf4dc639a9d158c404141edcae0c8498db4a0336234a3506eee7b3812e811535d44a4707d334e33efb5d7b6456c8cd3ec2",
        // rpc: "https://arbitrum-goerli.public.blastapi.io",
        rpc: "https://chain-rpc.litprotocol.com/http",
    });
    await pkpWallet.init();

    const gasLimit = 21000;
    const value = "0x0";
    const data = "0x";

    const transactionRequest = {
        from: pkpWallet.address,
        to: ZeroAddress,
        value,
        data,
    };

    const signedTransactionRequest = await pkpWallet.signTransaction(
        transactionRequest
    );

    console.log(signedTransactionRequest)

    // const tx = await pkpWallet.sendTransaction(signedTransactionRequest);
    // console.log(tx)
}

sendExampleTx()
