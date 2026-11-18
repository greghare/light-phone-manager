const { signAsync } = require('@electron/osx-sign');

// electron-builder 24 does not handle identity: "-" as ad-hoc signing itself.
module.exports = async function (options) {
    await signAsync({
        ...options,
        identity: '-',
        identityValidation: false,
    });
};
