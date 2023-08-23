const LitJsSdk = require('@lit-protocol/lit-node-client-nodejs');
const { ethers } = require("ethers");
const siwe = require('siwe');

async function generateAuth() {
    // Initialize LitNodeClient
    const litNodeClient = new LitJsSdk.LitNodeClientNodeJs();
    await litNodeClient.connect();

    // Initialize the signer
    const wallet = new ethers.Wallet(process.env.PK);
    const {address} = wallet

    // Craft the SIWE message
    const domain = 'localhost';
    const origin = 'https://localhost/login';
    const statement =
        'This is a test statement.  You can put anything you want here.';
    const siweMessage = new siwe.SiweMessage({
        domain,
        address: address,
        statement,
        uri: origin,
        version: '1',
        chainId: '1',
    });
    const messageToSign = siweMessage.prepareMessage();

    // Sign the message and format the authSig
    const signature = await wallet.signMessage(messageToSign);

    const authSig = {
        sig: signature,
        derivedVia: 'web3.eth.personal.sign',
        signedMessage: messageToSign,
        address: address,
    };

    // console.log(authSig);

    return authSig
}

module.exports = {generateAuth}

// generateAuth();

