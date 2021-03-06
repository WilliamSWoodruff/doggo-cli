'use strict';

const Fs = require('fs').promises;

const Bounce = require('bounce');
const Joi = require('joi');
const Automerge = require('automerge');
const Uuid = require('uuid');
const Enquirer = require('enquirer');
const Fuse = require('fuse.js');
const DoggoPackage = require('doggo/package.json');

// TODO Need to have a mini version of package-lock where we define the version
// numbers of each module used (doggo, doggo-cli, doggo-adapter-gpg, ...etc)

const DoggoAdapterGpg = require('doggo-adapter-gpg')({});
const Doggo = require('doggo')(DoggoAdapterGpg, {});

const Helpers = require('./helpers');

const internals = {};

exports.getInstance = async (instanceStr, fingerprint) => {

    return await internals.getInstance(instanceStr, fingerprint);
};

exports.list = async (secretPathOrString, keyIdentifier, search) => {

    const { getInstance } = internals;

    try {
        const instance = await Helpers.withErrHandling(getInstance, secretPathOrString, keyIdentifier);

        let output = instance.secrets;

        if (search) {
            output = await Helpers.withErrHandling(internals.search, output, search, { keys: ['tags'] });
        }

        return { output };
    }
    catch (error) {
        Bounce.rethrow(error, 'system');
        return { error };
    }
};

exports.add = async (secretPathOrString, keyIdentifier) => {

    const localTag = await Helpers.getDecrypted(secretPathOrString);

    const { getInstance, getTagsFromString, slugifyTags } = internals;

    try {
        Helpers.assert([localTag, keyIdentifier], '"secretPathOrString, keyIdentifier" are required to add secret');

        const instance = await Helpers.withErrHandling(getInstance, localTag, keyIdentifier);

        let tags = await Helpers.prompt('Enter tags to find this secret later');
        const secret = await Helpers.prompt('Enter secret');

        tags = getTagsFromString(tags);

        // IMPORTANT NOTE: Only use single quotes on Automerge messages, using double quotes breaks Automerge.load later /shrug
        const updatedTag = Automerge.change(instance, `Add '${slugifyTags(tags)}'`, (draft) => {

            draft.secrets.push({ tags, secret, id: Uuid.v4() });
            draft.version = Automerge.getHistory(instance).length + 1;
            draft.doggoVersion = DoggoPackage.version;
        });

        return { output: updatedTag };
    }
    catch (error) {
        Bounce.rethrow(error, 'system');
        return { error };
    }
};

exports.delete = async (secretPathOrString, keyIdentifier, search) => {

    const { getInstance, getSingleFromList } = internals;

    try {
        Helpers.assert([secretPathOrString, keyIdentifier, search], '"secretPathOrString, keyIdentifier, search" are required to delete secret');

        const instance = await Helpers.withErrHandling(getInstance, secretPathOrString, keyIdentifier);
        const toDelete = await Helpers.withErrHandling(getSingleFromList, instance.secrets, search || '', { keys: ['tags'] });

        if (!toDelete) {
            return { error: 'No result found for search' };
        }

        const { areYouSure } = await Enquirer.prompt({
            type: 'confirm',
            name: 'areYouSure',
            message: `Are you sure you want to delete secret "${internals.slugifyTags(toDelete.tags)}"?`
        });

        if (!areYouSure) {
            return { error: 'Delete cancelled' };
        }

        const { areYouReallySure } = await Enquirer.prompt({
            type: 'confirm',
            name: 'areYouReallySure',
            message: `Are you REALLY sure you want to delete secret "${internals.slugifyTags(toDelete.tags)}"?`
        });

        if (!areYouReallySure) {
            return { error: 'Delete cancelled' };
        }

        // IMPORTANT NOTE: Only use single quotes on Automerge messages, using double quotes breaks Automerge.load later /shrug
        const updatedTag = Automerge.change(instance, `Delete '${internals.slugifyTags(toDelete.tags)}'`, (draft) => {

            draft.secrets.splice(draft.secrets.findIndex((item) => item.id === toDelete.id), 1);
            draft.version = Automerge.getHistory(instance).length + 1;
            draft.doggoVersion = DoggoPackage.version;
        });

        return { output: updatedTag };
    }
    catch (error) {
        Bounce.rethrow(error, 'system');
        return { error };
    }
};

exports.update = async (secretPathOrString, keyIdentifier, search) => {

    const { getInstance, getSingleFromList, slugifyTags } = internals;

    try {
        Helpers.assert([secretPathOrString, keyIdentifier], '"secretPathOrString, keyIdentifier" are required to update secret');

        const instance = await Helpers.withErrHandling(getInstance, secretPathOrString, keyIdentifier);
        const toUpdate = await Helpers.withErrHandling(getSingleFromList, instance.secrets, search || '', { keys: ['tags'] });

        if (!toUpdate) {
            return { output: 'No result found for search' };
        }

        const choices = Object.entries(toUpdate)
            .filter(([key]) => key !== 'id' && key !== 'isDoggo') // Don't allow the user to edit 'id' or 'isDoggo'
            .map(([key, value]) => ({ name: key, initial: key !== 'tags' ? value : slugifyTags(value) }));

        const { edited } = await Enquirer.prompt({
            type: 'form',
            name: 'edited',
            message: `Editing '${toUpdate.tags}'`,
            choices
        });

        // IMPORTANT NOTE: Only use single quotes on Automerge messages, using double quotes breaks Automerge.load later /shrug
        const updatedTag = Automerge.change(instance, `Update '${slugifyTags(toUpdate.tags)}'`, (draft) => {

            draft.secrets.splice(draft.secrets.findIndex((item) => item.id === toUpdate.id), 1, Object.assign({}, toUpdate, edited));
            draft.version = Automerge.getHistory(instance).length + 1;
            draft.doggoVersion = DoggoPackage.version;
            draft.updatedAt = Date.now();
        });

        return { output: updatedTag };
    }
    catch (error) {
        Bounce.rethrow(error, 'system');
        return { error };
    }
};

exports.getAutomergeSave = (instance) => {

    try {
        return { output: Automerge.save(instance).replace(/\r?\n|\r/g, ' ') };
    }
    catch (error) {
        Bounce.rethrow(error, 'system');
        return { error };
    }
};

exports.encryptAndSave = async (savePath, keyIdentifier, instance) => {

    try {
        if (!keyIdentifier || !instance) {
            throw new Error('"keyIdentifier, instance" are required to save');
        }

        await Fs.writeFile(
            savePath,
            await Helpers.withErrHandling(
                Doggo.api.encrypt,
                keyIdentifier,
                await Helpers.withErrHandling(
                    exports.getAutomergeSave,
                    instance
                )
            )
        );
    }
    catch (error) {
        Bounce.rethrow(error, 'system');
        return { error };
    }
};

exports.merge = (localTag, remoteTag) => Automerge.merge(localTag, remoteTag);

exports.diff = (localTag, remoteTag) => Automerge.diff(localTag, remoteTag);

exports.init = () => {

    // IMPORTANT NOTE: Only use single quotes on Automerge messages, using double quotes breaks 'Automerge.load' later /shrug
    return Automerge.change(Automerge.init(), 'Initialize', (draft) => {

        // Special property to denote that doggo created it
        draft.isDoggo = true;
        draft.id = Uuid.v4();
        draft.version = 1;
        draft.secrets = [];
        draft.doggoVersion = DoggoPackage.version;
        draft.updatedAt = Date.now();
    });
};

internals.stateSchema = Joi.object({
    version: Joi.number(),
    secrets: Joi.array()
});

internals.getInstance = async (strOrPath) => {

    try {
        return { output: await Automerge.load(await Helpers.getDecrypted(strOrPath)) };
    }
    catch (error) {
        Bounce.rethrow(error, 'system');
        return { error };
    }
};

internals.getSingleFromList = async (list, search, options = {}) => {

    const { slugifyTags } = internals;

    try {
        const results = await Helpers.withErrHandling(internals.search, list, search, options);

        let result = results[0];

        if (results.length > 1) {

            const joinedTags = results.map((r) => slugifyTags(r.tags));

            const { chosenResult } = await Enquirer.prompt([{
                type: 'select',
                name: 'chosenResult',
                message: 'Choose from the list',
                choices: joinedTags
            }]);

            result = list.find((item) => chosenResult === slugifyTags(item.tags));
        }

        return { output: result };
    }
    catch (error) {
        Bounce.rethrow(error, 'system');
        return { error };
    }
};

internals.search = (list, search, options = {}) => {

    try {
        let res = new Fuse(list, options).search(search);

        // If the results are all numbers, an array of strings was passed as 'list'
        if (res.map((item) => parseInt(item)).filter((item) => !isNaN(item)).length === res.length) {
            res = res.map((index) => list[index]);
        }

        // If options.id is defined, Fuse will send back the id of the match
        if (options && options.keys && options.id) {
            res = list.filter((item) => res.includes(item.id));
        }

        return { output: res };
    }
    catch (error) {
        Bounce.rethrow(error, 'system');
        return { error };
    }
};

internals.slugifyTags = (tags) => tags.join(', ');

internals.getTagsFromString = (str) => str.split(/[\s,]+/g);
