'use strict';

const config = require('wild-config');
const Joi = require('../joi');
const MongoPaging = require('mongo-cursor-pagination');
const ObjectID = require('mongodb').ObjectID;
const tools = require('../tools');
const errors = require('../errors');
const openpgp = require('openpgp');
const addressparser = require('nodemailer/lib/addressparser');
const libmime = require('libmime');
const consts = require('../consts');
const roles = require('../roles');
const util = require('util');

module.exports = (db, server, userHandler) => {
    const createUser = util.promisify(userHandler.create.bind(userHandler));
    const updateUser = util.promisify(userHandler.update.bind(userHandler));
    const logoutUser = util.promisify(userHandler.logout.bind(userHandler));
    const resetUser = util.promisify(userHandler.reset.bind(userHandler));
    const deleteUser = util.promisify(userHandler.delete.bind(userHandler));

    /**
     * @api {get} /users List registered Users
     * @apiName GetUsers
     * @apiGroup Users
     * @apiHeader {String} X-Access-Token Optional access token if authentication is enabled
     * @apiHeaderExample {json} Header-Example:
     * {
     *   "X-Access-Token": "59fc66a03e54454869460e45"
     * }
     *
     * @apiParam {String} [query] Partial match of username or default email address
     * @apiParam {String} [tags] Comma separated list of tags. The User must have at least one to be set
     * @apiParam {String} [requiredTags] Comma separated list of tags. The User must have all listed tags to be set
     * @apiParam {Number} [limit=20] How many records to return
     * @apiParam {Number} [page=1] Current page number. Informational only, page numbers start from 1
     * @apiParam {Number} [next] Cursor value for next page, retrieved from <code>nextCursor</code> response value
     * @apiParam {Number} [previous] Cursor value for previous page, retrieved from <code>previousCursor</code> response value
     *
     * @apiSuccess {Boolean} success Indicates successful response
     * @apiSuccess {Number} total How many results were found
     * @apiSuccess {Number} page Current page number. Derived from <code>page</code> query argument
     * @apiSuccess {String} previousCursor Either a cursor string or false if there are not any previous results
     * @apiSuccess {String} nextCursor Either a cursor string or false if there are not any next results
     * @apiSuccess {Object[]} results User listing
     * @apiSuccess {String} results.id Users unique ID (24 byte hex)
     * @apiSuccess {String} results.username Username of the User
     * @apiSuccess {String} results.name Name of the User
     * @apiSuccess {String} results.address Main email address of the User
     * @apiSuccess {String[]} results.tags List of tags associated with the User'
     * @apiSuccess {String[]} results.targets List of forwarding targets
     * @apiSuccess {Boolean} results.encryptMessages If <code>true</code> then received messages are encrypted
     * @apiSuccess {Boolean} results.encryptForwarded If <code>true</code> then forwarded messages are encrypted
     * @apiSuccess {Object} results.quota Quota usage limits
     * @apiSuccess {Number} results.quota.allowed Allowed quota of the user in bytes
     * @apiSuccess {Number} results.quota.used Space used in bytes
     * @apiSuccess {Boolean} results.hasPasswordSet If <code>true</code> then the User has a password set and can authenticate
     * @apiSuccess {Boolean} results.activated Is the account activated
     * @apiSuccess {Boolean} results.disabled If <code>true</code> then the user can not authenticate or receive any new mail
     *
     * @apiError error Description of the error
     *
     * @apiExample {curl} Example usage:
     *     curl -i http://localhost:8080/users
     *
     * @apiSuccessExample {json} Success-Response:
     *     HTTP/1.1 200 OK
     *     {
     *       "success": true,
     *       "total": 1,
     *       "page": 1,
     *       "previousCursor": false,
     *       "nextCursor": false,
     *       "results": [
     *         {
     *           "id": "59cb948ad80a820b68f05230",
     *           "username": "myuser",
     *           "name": "John Doe",
     *           "address": "john@example.com",
     *           "tags": [],
     *           "forward": [],
     *           "encryptMessages": false,
     *           "encryptForwarded": false,
     *           "quota": {
     *             "allowed": 1073741824,
     *             "used": 17799833
     *           },
     *           "hasPasswordSet": true,
     *           "activated": true,
     *           "disabled": false
     *         }
     *       ]
     *     }
     *
     * @apiErrorExample {json} Error-Response:
     *     HTTP/1.1 200 OK
     *     {
     *       "error": "Database error"
     *     }
     */
    server.get(
        { name: 'users', path: '/users' },
        tools.asyncifyJson(async (req, res, next) => {
            res.charSet('utf-8');

            const schema = Joi.object().keys({
                query: Joi.string()
                    .empty('')
                    .lowercase()
                    .max(128),
                tags: Joi.string()
                    .trim()
                    .empty('')
                    .max(1024),
                requiredTags: Joi.string()
                    .trim()
                    .empty('')
                    .max(1024),
                limit: Joi.number()
                    .default(20)
                    .min(1)
                    .max(250),
                next: Joi.string()
                    .empty('')
                    .mongoCursor()
                    .max(1024),
                previous: Joi.string()
                    .empty('')
                    .mongoCursor()
                    .max(1024),
                page: Joi.number().default(1)
            });

            const result = Joi.validate(req.query, schema, {
                abortEarly: false,
                convert: true,
                allowUnknown: true
            });

            if (result.error) {
                res.json({
                    error: result.error.message,
                    code: 'InputValidationError'
                });
                return next();
            }

            // permissions check
            req.validate(roles.can(req.role).readAny('users'));

            let query = result.value.query;
            let limit = result.value.limit;
            let page = result.value.page;
            let pageNext = result.value.next;
            let pagePrevious = result.value.previous;

            let filter = query
                ? {
                      $or: [
                          {
                              address: {
                                  $regex: tools.escapeRegexStr(query),
                                  $options: ''
                              }
                          },
                          {
                              unameview: {
                                  $regex: tools.escapeRegexStr(tools.uview(query)),
                                  $options: ''
                              }
                          }
                      ]
                  }
                : {};

            let tagSeen = new Set();

            let requiredTags = (result.value.requiredTags || '')
                .split(',')
                .map(tag => tag.toLowerCase().trim())
                .filter(tag => {
                    if (tag && !tagSeen.has(tag)) {
                        tagSeen.add(tag);
                        return true;
                    }
                    return false;
                });

            let tags = (result.value.tags || '')
                .split(',')
                .map(tag => tag.toLowerCase().trim())
                .filter(tag => {
                    if (tag && !tagSeen.has(tag)) {
                        tagSeen.add(tag);
                        return true;
                    }
                    return false;
                });

            let tagsview = {};
            if (requiredTags.length) {
                tagsview.$all = requiredTags;
            }
            if (tags.length) {
                tagsview.$in = tags;
            }

            if (requiredTags.length || tags.length) {
                filter.tagsview = tagsview;
            }

            let total = await db.users.collection('users').countDocuments(filter);

            let opts = {
                limit,
                query: filter,
                fields: {
                    // FIXME: hack to keep _id in response
                    _id: true,
                    // FIXME: MongoPaging inserts fields value as second argument to col.find()
                    projection: {
                        _id: true,
                        username: true,
                        name: true,
                        address: true,
                        tags: true,
                        storageUsed: true,
                        targets: true,
                        quota: true,
                        activated: true,
                        disabled: true,
                        password: true,
                        encryptMessages: true,
                        encryptForwarded: true
                    }
                },
                // _id gets removed in response if not explicitly set in paginatedField
                paginatedField: '_id',
                sortAscending: true
            };

            if (pageNext) {
                opts.next = pageNext;
            } else if (page > 1 && pagePrevious) {
                opts.previous = pagePrevious;
            }

            let listing;
            try {
                listing = await MongoPaging.find(db.users.collection('users'), opts);
            } catch (err) {
                res.json({
                    error: 'MongoDB Error: ' + err.message,
                    code: 'InternalDatabaseError'
                });
                return next();
            }

            if (!listing.hasPrevious) {
                page = 1;
            }

            let response = {
                success: true,
                query,
                total,
                page,
                previousCursor: listing.hasPrevious ? listing.previous : false,
                nextCursor: listing.hasNext ? listing.next : false,
                results: (listing.results || []).map(userData => ({
                    id: userData._id.toString(),
                    username: userData.username,
                    name: userData.name,
                    address: userData.address,
                    tags: userData.tags || [],
                    targets: userData.targets && userData.targets.map(t => t.value),
                    encryptMessages: !!userData.encryptMessages,
                    encryptForwarded: !!userData.encryptForwarded,
                    quota: {
                        allowed: Number(userData.quota) || config.maxStorage * 1024 * 1024,
                        used: Math.max(Number(userData.storageUsed) || 0, 0)
                    },
                    hasPasswordSet: !!userData.password || !!userData.tempPassword,
                    activated: userData.activated,
                    disabled: userData.disabled
                }))
            };

            res.json(response);
            return next();
        })
    );

    /**
     * @api {post} /users Create new user
     * @apiName PostUser
     * @apiGroup Users
     * @apiHeader {String} X-Access-Token Optional access token if authentication is enabled
     * @apiHeaderExample {json} Header-Example:
     * {
     *   "X-Access-Token": "59fc66a03e54454869460e45"
     * }
     *
     * @apiParam {String} name Username of the User. Dots are allowed but informational only (<em>"user.name"</em> is the same as <em>"username"</em>).
     * @apiParam {String} [name] Name of the User
     * @apiParam {String} password Password for the account. Set to boolean <code>false</code> to disable password usage
     * @apiParam {String} [address] Default email address for the User (autogenerated if not set)
     * @apiParam {Boolean} [emptyAddress] If true then do not autogenerate missing email address for the User. Only needed if you want to create an user account that does not have any email address associated
     * @apiParam {Boolean} [requirePasswordChange] If true then requires the user to change password, useful if password for the account was autogenerated
     * @apiParam {String[]} [tags] A list of tags associated with this user
     * @apiParam {Boolean} [addTagsToAddress] If <code>true</code> then autogenerated address gets the same tags as the user
     * @apiParam {Number} [retention] Default retention time in ms. Set to <code>0</code> to disable
     * @apiParam {Boolean} [encryptMessages] If <code>true</code> then received messages are encrypted
     * @apiParam {Boolean} [encryptForwarded] If <code>true</code> then forwarded messages are encrypted
     * @apiParam {String} [pubKey] Public PGP key for the User that is used for encryption. Use empty string to remove the key
     * @apiParam {String} [language] Language code for the User
     * @apiParam {String[]} [targets] An array of forwarding targets. The value could either be an email address or a relay url to next MX server ("smtp://mx2.zone.eu:25") or an URL where mail contents are POSTed to
     * @apiParam {Number} [spamLevel=50] Relative scale for detecting spam. 0 means that everything is spam, 100 means that nothing is spam
     * @apiParam {Number} [quota] Allowed quota of the user in bytes
     * @apiParam {Number} [recipients] How many messages per 24 hour can be sent
     * @apiParam {Number} [forwards] How many messages per 24 hour can be forwarded
     * @apiParam {Number} [imapMaxUpload] How many bytes can be uploaded via IMAP during 24 hour
     * @apiParam {Number} [imapMaxDownload] How many bytes can be downloaded via IMAP during 24 hour
     * @apiParam {Number} [pop3MaxDownload] How many bytes can be downloaded via POP3 during 24 hour
     * @apiParam {Number} [receivedMax] How many messages can be received from MX during 1 hour
     * @apiParam {String} [sess] Session identifier for the logs
     * @apiParam {String} [ip] IP address for the logs
     *
     * @apiSuccess {Boolean} success Indicates successful response
     * @apiSuccess {String} id ID for the created User
     *
     * @apiError error Description of the error
     *
     * @apiExample {curl} Example usage:
     *     curl -i -XPOST http://localhost:8080/users \
     *     -H 'Content-type: application/json' \
     *     -d '{
     *       "username": "myuser",
     *       "password": "verysecret",
     *       "name": "John Doe",
     *       "address": "john.doe@example.com",
     *       "tags": [
     *         "status:regular_user",
     *         "subscription:business_big"
     *       ]
     *     }'
     *
     * @apiExample {curl} Example address:
     *     curl -i -XPOST http://localhost:8080/users \
     *     -H 'Content-type: application/json' \
     *     -d '{
     *       "username": "john.doe@example.com",
     *       "password": "verysecret",
     *       "name": "John Doe",
     *       "tags": [
     *         "status:regular_user",
     *         "subscription:business_big"
     *       ]
     *     }'
     *
     * @apiSuccessExample {json} Success-Response:
     *     HTTP/1.1 200 OK
     *     {
     *       "success": true,
     *       "id": "5a1bda70bfbd1442cd96c6f0"
     *     }
     *
     * @apiErrorExample {json} Error-Response:
     *     HTTP/1.1 200 OK
     *     {
     *       "error": "This username already exists"
     *     }
     */
    server.post(
        '/users',
        tools.asyncifyJson(async (req, res, next) => {
            res.charSet('utf-8');

            const schema = Joi.object().keys({
                username: Joi.string()
                    .lowercase()
                    // no spaces, printable range
                    .regex(/^[\x21-\x7e]{1,128}?$/, 'username')
                    .min(1)
                    .max(128)
                    .required(),
                password: Joi.string()
                    .allow(false)
                    .max(256)
                    .required(),

                address: Joi.string().email(),
                emptyAddress: Joi.boolean()
                    .truthy(['Y', 'true', 'yes', 'on', 1])
                    .falsy(['N', 'false', 'no', 'off', 0, ''])
                    .default(false),

                language: Joi.string()
                    .min(2)
                    .max(20)
                    .lowercase(),
                retention: Joi.number()
                    .min(0)
                    .default(0),

                name: Joi.string().max(256),
                targets: Joi.array().items(
                    Joi.string().email(),
                    Joi.string().uri({
                        scheme: [/smtps?/, /https?/],
                        allowRelative: false,
                        relativeOnly: false
                    })
                ),

                spamLevel: Joi.number()
                    .min(0)
                    .max(100)
                    .default(50),

                quota: Joi.number()
                    .min(0)
                    .default(0),
                recipients: Joi.number()
                    .min(0)
                    .default(0),
                forwards: Joi.number()
                    .min(0)
                    .default(0),

                requirePasswordChange: Joi.boolean()
                    .truthy(['Y', 'true', 'yes', 'on', 1])
                    .falsy(['N', 'false', 'no', 'off', 0, ''])
                    .default(false),

                imapMaxUpload: Joi.number()
                    .min(0)
                    .default(0),
                imapMaxDownload: Joi.number()
                    .min(0)
                    .default(0),
                pop3MaxDownload: Joi.number()
                    .min(0)
                    .default(0),
                receivedMax: Joi.number()
                    .min(0)
                    .default(0),

                tags: Joi.array().items(
                    Joi.string()
                        .trim()
                        .max(128)
                ),
                addTagsToAddress: Joi.boolean()
                    .truthy(['Y', 'true', 'yes', 'on', 1])
                    .falsy(['N', 'false', 'no', 'off', 0, ''])
                    .default(false),

                pubKey: Joi.string()
                    .empty('')
                    .trim()
                    .regex(/^-----BEGIN PGP PUBLIC KEY BLOCK-----/, 'PGP key format'),
                encryptMessages: Joi.boolean()
                    .truthy(['Y', 'true', 'yes', 'on', 1])
                    .falsy(['N', 'false', 'no', 'off', 0, ''])
                    .default(false),
                encryptForwarded: Joi.boolean()
                    .truthy(['Y', 'true', 'yes', 'on', 1])
                    .falsy(['N', 'false', 'no', 'off', 0, ''])
                    .default(false),
                sess: Joi.string().max(255),
                ip: Joi.string().ip({
                    version: ['ipv4', 'ipv6'],
                    cidr: 'forbidden'
                })
            });

            const result = Joi.validate(req.params, schema, {
                abortEarly: false,
                convert: true
            });

            if (result.error) {
                res.json({
                    error: result.error.message,
                    code: 'InputValidationError'
                });
                return next();
            }

            // permissions check
            req.validate(roles.can(req.role).createAny('users'));

            let targets = result.value.targets;

            if (targets) {
                for (let i = 0, len = targets.length; i < len; i++) {
                    let target = targets[i];
                    if (!/^smtps?:/i.test(target) && !/^https?:/i.test(target) && target.indexOf('@') >= 0) {
                        // email
                        targets[i] = {
                            id: new ObjectID(),
                            type: 'mail',
                            value: target
                        };
                    } else if (/^smtps?:/i.test(target)) {
                        targets[i] = {
                            id: new ObjectID(),
                            type: 'relay',
                            value: target
                        };
                    } else if (/^https?:/i.test(target)) {
                        targets[i] = {
                            id: new ObjectID(),
                            type: 'http',
                            value: target
                        };
                    } else {
                        res.json({
                            error: 'Unknown target type "' + target + '"',
                            code: 'InputValidationError'
                        });
                        return next();
                    }
                }

                result.value.targets = targets;
            }

            if ('pubKey' in req.params && !result.value.pubKey) {
                result.value.pubKey = '';
            }

            if (result.value.tags) {
                let tagSeen = new Set();
                let tags = result.value.tags
                    .map(tag => tag.trim())
                    .filter(tag => {
                        if (tag && !tagSeen.has(tag.toLowerCase())) {
                            tagSeen.add(tag.toLowerCase());
                            return true;
                        }
                        return false;
                    })
                    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

                result.value.tags = tags;
                result.value.tagsview = tags.map(tag => tag.toLowerCase());
            }

            if (result.value.username.indexOf('*') >= 0) {
                res.json({
                    error: 'Invalid character in username: *',
                    code: 'InputValidationError'
                });
                return next();
            }

            if (/^\.|\.$|\.{2,}/g.test(result.value.username) || !/[^.]/.test(result.value.username)) {
                res.json({
                    error: 'Invalid dot symbols in username',
                    code: 'InputValidationError'
                });
                return next();
            }

            if (result.value.address && result.value.address.indexOf('*') >= 0) {
                res.json({
                    error: 'Invalid character in email address: *',
                    code: 'InputValidationError'
                });
                return next();
            }

            try {
                await checkPubKey(result.value.pubKey);
            } catch (err) {
                res.json({
                    error: 'PGP key validation failed. ' + err.message,
                    code: 'InputValidationError'
                });
                return next();
            }

            let id;
            try {
                id = await createUser(result.value);
            } catch (err) {
                res.json({
                    error: err.message,
                    code: err.code,
                    username: result.value.username
                });
                return next();
            }

            res.json({
                success: !!id,
                id
            });

            return next();
        })
    );

    /**
     * @api {get} /users/resolve/:username Resolve ID for an username
     * @apiName GetUsername
     * @apiGroup Users
     * @apiHeader {String} X-Access-Token Optional access token if authentication is enabled
     * @apiHeaderExample {json} Header-Example:
     * {
     *   "X-Access-Token": "59fc66a03e54454869460e45"
     * }
     *
     * @apiParam {String} username Username of the User. Alphanumeric value. Must start with a letter, dots are allowed but informational only (<em>"user.name"</em> is the same as <em>"username"</em>)
     *
     * @apiSuccess {Boolean} success Indicates successful response
     * @apiSuccess {String} id Users unique ID (24 byte hex)
     *
     * @apiError error Description of the error
     *
     * @apiExample {curl} Example usage:
     *     curl -i http://localhost:8080/users/resolve/testuser
     *
     * @apiSuccessExample {json} Success-Response:
     *     HTTP/1.1 200 OK
     *     {
     *       "success": true,
     *       "id": "59fc66a03e54454869460e45"
     *     }
     *
     * @apiErrorExample {json} Error-Response:
     *     HTTP/1.1 200 OK
     *     {
     *       "error": "This user does not exist"
     *     }
     */
    server.get(
        '/users/resolve/:username',
        tools.asyncifyJson(async (req, res, next) => {
            res.charSet('utf-8');

            const schema = Joi.object().keys({
                username: Joi.string()
                    .lowercase()
                    .regex(/^[a-z0-9][a-z0-9.]+[a-z0-9]$/, 'username')
                    .min(3)
                    .max(32)
                    .required()
            });

            const result = Joi.validate(req.params, schema, {
                abortEarly: false,
                convert: true
            });

            if (result.error) {
                res.json({
                    error: result.error.message,
                    code: 'InputValidationError'
                });
                return next();
            }

            // permissions check
            req.validate(roles.can(req.role).readAny('users'));

            let username = result.value.username;

            let userData;
            try {
                userData = await db.users.collection('users').findOne(
                    {
                        unameview: username.replace(/\./g, '')
                    },
                    {
                        projection: {
                            _id: true
                        }
                    }
                );
            } catch (err) {
                res.json({
                    error: 'MongoDB Error: ' + err.message,
                    code: 'InternalDatabaseError'
                });
                return next();
            }

            if (!userData) {
                res.json({
                    error: 'This user does not exist',
                    code: 'UserNotFound'
                });
                return next();
            }

            res.json({
                success: true,
                id: userData._id
            });

            return next();
        })
    );

    /**
     * @api {get} /users/:id Request User information
     * @apiName GetUser
     * @apiGroup Users
     * @apiHeader {String} X-Access-Token Optional access token if authentication is enabled
     * @apiHeaderExample {json} Header-Example:
     * {
     *   "X-Access-Token": "59fc66a03e54454869460e45"
     * }
     *
     * @apiParam {String} id Users unique ID.
     *
     * @apiSuccess {Boolean} success Indicates successful response
     * @apiSuccess {String} id Users unique ID (24 byte hex)
     * @apiSuccess {String} username Username of the User
     * @apiSuccess {String} name Name of the User
     * @apiSuccess {String} address Main email address of the User
     * @apiSuccess {Number} retention Default retention time in ms. <code>false</code> if not enabled
     * @apiSuccess {String[]} enabled2fa List of enabled 2FA methods
     * @apiSuccess {Boolean} encryptMessages If <code>true</code> then received messages are encrypted
     * @apiSuccess {Boolean} encryptForwarded If <code>true</code> then forwarded messages are encrypted
     * @apiSuccess {String} pubKey Public PGP key for the User that is used for encryption
     * @apiSuccess {Object} keyInfo Information about public key or <code>false</code> if key is not available
     * @apiSuccess {String} keyInfo.name Name listed in public key
     * @apiSuccess {String} keyInfo.address E-mail address listed in public key
     * @apiSuccess {String} keyInfo.fingerprint Fingerprint of the public key
     * @apiSuccess {String[]} targets List of forwarding targets
     * @apiSuccess {Number} spamLevel Relative scale for detecting spam. 0 means that everything is spam, 100 means that nothing is spam
     * @apiSuccess {Object} limits Account limits and usage
     * @apiSuccess {Object} limits.quota Quota usage limits
     * @apiSuccess {Number} limits.quota.allowed Allowed quota of the user in bytes
     * @apiSuccess {Number} limits.quota.used Space used in bytes
     * @apiSuccess {Object} limits.recipients Sending quota
     * @apiSuccess {Number} limits.recipients.allowed How many messages per 24 hours can be sent
     * @apiSuccess {Number} limits.recipients.used How many messages are sent during current 24 hour period
     * @apiSuccess {Number} limits.recipients.ttl Time until the end of current 24 hour period
     * @apiSuccess {Object} limits.forwards Forwarding quota
     * @apiSuccess {Number} limits.forwards.allowed How many messages per 24 hours can be forwarded
     * @apiSuccess {Number} limits.forwards.used  How many messages are forwarded during current 24 hour period
     * @apiSuccess {Number} limits.forwards.ttl Time until the end of current 24 hour period
     * @apiSuccess {Object} limits.received Receiving quota
     * @apiSuccess {Number} limits.received.allowed How many messages per 1 hour can be received
     * @apiSuccess {Number} limits.received.used How many messages are received during current 1 hour period
     * @apiSuccess {Number} limits.received.ttl Time until the end of current 1 hour period
     * @apiSuccess {Object} limits.imapUpload IMAP upload quota
     * @apiSuccess {Number} limits.imapUpload.allowed How many bytes per 24 hours can be uploaded via IMAP. Only message contents are counted, not protocol overhead.
     * @apiSuccess {Number} limits.imapUpload.used How many bytes are uploaded during current 24 hour period
     * @apiSuccess {Number} limits.imapUpload.ttl Time until the end of current 24 hour period
     * @apiSuccess {Object} limits.imapDownload IMAP download quota
     * @apiSuccess {Number} limits.imapDownload.allowed How many bytes per 24 hours can be downloaded via IMAP. Only message contents are counted, not protocol overhead.
     * @apiSuccess {Number} limits.imapDownload.used How many bytes are downloaded during current 24 hour period
     * @apiSuccess {Number} limits.imapDownload.ttl Time until the end of current 24 hour period
     * @apiSuccess {Object} limits.pop3Download POP3 download quota
     * @apiSuccess {Number} limits.pop3Download.allowed How many bytes per 24 hours can be downloaded via POP3. Only message contents are counted, not protocol overhead.
     * @apiSuccess {Number} limits.pop3Download.used How many bytes are downloaded during current 24 hour period
     * @apiSuccess {Number} limits.pop3Download.ttl Time until the end of current 24 hour period
     *
     * @apiSuccess {String[]} tags List of tags associated with the User
     * @apiSuccess {Boolean} hasPasswordSet If <code>true</code> then the User has a password set and can authenticate
     * @apiSuccess {Boolean} activated Is the account activated
     * @apiSuccess {Boolean} disabled If <code>true</code> then the user can not authenticate or receive any new mail
     *
     * @apiError error Description of the error
     *
     * @apiExample {curl} Example usage:
     *     curl -i http://localhost:8080/users/59fc66a03e54454869460e45
     *
     * @apiSuccessExample {json} Success-Response:
     *     HTTP/1.1 200 OK
     *     {
     *       "success": true,
     *       "id": "59fc66a03e54454869460e45",
     *       "username": "testuser01",
     *       "name": null,
     *       "address": "testuser01@example.com",
     *       "retention": false,
     *       "enabled2fa": [],
     *       "encryptMessages": false,
     *       "encryptForwarded": false,
     *       "pubKey": "",
     *       "keyInfo": false,
     *       "targets": [
     *           "my.old.address@example.com",
     *           "smtp://mx2.zone.eu:25"
     *       ],
     *       "limits": {
     *         "quota": {
     *           "allowed": 107374182400,
     *           "used": 289838
     *         },
     *         "recipients": {
     *           "allowed": 2000,
     *           "used": 0,
     *           "ttl": false
     *         },
     *         "forwards": {
     *           "allowed": 2000,
     *           "used": 0,
     *           "ttl": false
     *         }
     *       },
     *       "tags": ["green", "blue"],
     *       "hasPasswordSet": true,
     *       "activated": true,
     *       "disabled": false
     *     }
     *
     * @apiErrorExample {json} Error-Response:
     *     HTTP/1.1 200 OK
     *     {
     *       "error": "This user does not exist"
     *     }
     */
    server.get(
        '/users/:user',
        tools.asyncifyJson(async (req, res, next) => {
            res.charSet('utf-8');

            const schema = Joi.object().keys({
                user: Joi.string()
                    .hex()
                    .lowercase()
                    .length(24)
                    .required()
            });

            const result = Joi.validate(req.params, schema, {
                abortEarly: false,
                convert: true
            });

            if (result.error) {
                res.json({
                    error: result.error.message,
                    code: 'InputValidationError'
                });
                return next();
            }

            // permissions check
            if (req.user && req.user === result.value.user) {
                req.validate(roles.can(req.role).readOwn('users'));
            } else {
                req.validate(roles.can(req.role).readAny('users'));
            }

            let user = new ObjectID(result.value.user);

            let userData;

            try {
                userData = await db.users.collection('users').findOne({
                    _id: user
                });
            } catch (err) {
                res.json({
                    error: 'MongoDB Error: ' + err.message,
                    code: 'InternalDatabaseError'
                });
                return next();
            }

            if (!userData) {
                res.json({
                    error: 'This user does not exist',
                    code: 'UserNotFound'
                });
                return next();
            }

            let response;
            try {
                response = await db.redis
                    .multi()
                    // sending counters are stored in Redis

                    // sent messages
                    .get('wdr:' + userData._id.toString())
                    .ttl('wdr:' + userData._id.toString())

                    // forwarded messages
                    .get('wdf:' + userData._id.toString())
                    .ttl('wdf:' + userData._id.toString())

                    //  rate limited recipient
                    .get('rl:rcpt:' + userData._id.toString())
                    .ttl('rl:rcpt:' + userData._id.toString())

                    //  rate limited imap uploads
                    .get('iup:' + userData._id.toString())
                    .ttl('iup:' + userData._id.toString())

                    //  rate limited imap downloads
                    .get('idw:' + userData._id.toString())
                    .ttl('idw:' + userData._id.toString())

                    //  rate limited pop3 downloads
                    .get('pdw:' + userData._id.toString())
                    .ttl('pdw:' + userData._id.toString())

                    .exec();
            } catch (err) {
                // ignore
                errors.notify(err, { userId: user });
            }

            let recipients = Number(userData.recipients) || config.maxRecipients || consts.MAX_RECIPIENTS;
            let forwards = Number(userData.forwards) || config.maxForwards || consts.MAX_FORWARDS;

            let recipientsSent = Number(response && response[0] && response[0][1]) || 0;
            let recipientsTtl = Number(response && response[1] && response[1][1]) || 0;

            let forwardsSent = Number(response && response[2] && response[2][1]) || 0;
            let forwardsTtl = Number(response && response[3] && response[3][1]) || 0;

            let received = Number(response && response[4] && response[4][1]) || 0;
            let receivedTtl = Number(response && response[5] && response[5][1]) || 0;

            let imapUpload = Number(response && response[6] && response[6][1]) || 0;
            let imapUploadTtl = Number(response && response[7] && response[7][1]) || 0;

            let imapDownload = Number(response && response[8] && response[8][1]) || 0;
            let imapDownloadTtl = Number(response && response[9] && response[9][1]) || 0;

            let pop3Download = Number(response && response[10] && response[10][1]) || 0;
            let pop3DownloadTtl = Number(response && response[11] && response[11][1]) || 0;

            let keyInfo;
            try {
                keyInfo = await getKeyInfo(userData.pubKey);
            } catch (err) {
                errors.notify(err, { userId: user, source: 'pgp' });
            }

            res.json({
                success: true,
                id: user,

                username: userData.username,
                name: userData.name,

                address: userData.address,

                language: userData.language,
                retention: userData.retention || false,

                enabled2fa: Array.isArray(userData.enabled2fa) ? userData.enabled2fa : [].concat(userData.enabled2fa ? 'totp' : []),

                encryptMessages: userData.encryptMessages,
                encryptForwarded: userData.encryptForwarded,
                pubKey: userData.pubKey,
                spamLevel: userData.spamLevel,
                keyInfo,

                targets: [].concat(userData.targets || []),

                limits: {
                    quota: {
                        allowed: Number(userData.quota) || config.maxStorage * 1024 * 1024,
                        used: Math.max(Number(userData.storageUsed) || 0, 0)
                    },

                    recipients: {
                        allowed: recipients,
                        used: recipientsSent,
                        ttl: recipientsTtl >= 0 ? recipientsTtl : false
                    },

                    forwards: {
                        allowed: forwards,
                        used: forwardsSent,
                        ttl: forwardsTtl >= 0 ? forwardsTtl : false
                    },

                    received: {
                        allowed: Number(userData.receivedMax) || 150,
                        used: received,
                        ttl: receivedTtl >= 0 ? receivedTtl : false
                    },

                    imapUpload: {
                        allowed: Number(userData.imapMaxUpload) || (config.imap.maxUploadMB || 10) * 1024 * 1024,
                        used: imapUpload,
                        ttl: imapUploadTtl >= 0 ? imapUploadTtl : false
                    },

                    imapDownload: {
                        allowed: Number(userData.imapMaxDownload) || (config.imap.maxDownloadMB || 10) * 1024 * 1024,
                        used: imapDownload,
                        ttl: imapDownloadTtl >= 0 ? imapDownloadTtl : false
                    },

                    pop3Download: {
                        allowed: Number(userData.pop3MaxDownload) || (config.pop3.maxDownloadMB || 10) * 1024 * 1024,
                        used: pop3Download,
                        ttl: pop3DownloadTtl >= 0 ? pop3DownloadTtl : false
                    }
                },

                tags: userData.tags || [],
                hasPasswordSet: !!userData.password || !!userData.tempPassword,
                activated: userData.activated,
                disabled: userData.disabled
            });

            return next();
        })
    );

    /**
     * @api {put} /users/:id Update User information
     * @apiName PutUser
     * @apiGroup Users
     * @apiHeader {String} X-Access-Token Optional access token if authentication is enabled
     * @apiHeaderExample {json} Header-Example:
     * {
     *   "X-Access-Token": "59fc66a03e54454869460e45"
     * }
     *
     * @apiParam {String} id Users unique ID.
     * @apiParam {String} [name] Name of the User
     * @apiParam {String} [existingPassword] If provided then validates against account password before applying any changes
     * @apiParam {String} [password] New password for the account. Set to boolean <code>false</code> to disable password usage
     * @apiParam {String[]} [tags] A list of tags associated with this user
     * @apiParam {Number} [retention] Default retention time in ms. Set to <code>0</code> to disable
     * @apiParam {Boolean} [encryptMessages] If <code>true</code> then received messages are encrypted
     * @apiParam {Boolean} [encryptForwarded] If <code>true</code> then forwarded messages are encrypted
     * @apiParam {String} [pubKey] Public PGP key for the User that is used for encryption. Use empty string to remove the key
     * @apiParam {String} [language] Language code for the User
     * @apiParam {String[]} [targets] An array of forwarding targets. The value could either be an email address or a relay url to next MX server ("smtp://mx2.zone.eu:25") or an URL where mail contents are POSTed to
     * @apiParam {Number} [spamLevel] Relative scale for detecting spam. 0 means that everything is spam, 100 means that nothing is spam
     * @apiParam {Number} [quota] Allowed quota of the user in bytes
     * @apiParam {Number} [recipients] How many messages per 24 hour can be sent
     * @apiParam {Number} [forwards] How many messages per 24 hour can be forwarded
     * @apiParam {Number} [imapMaxUpload] How many bytes can be uploaded via IMAP during 24 hour
     * @apiParam {Number} [imapMaxDownload] How many bytes can be downloaded via IMAP during 24 hour
     * @apiParam {Number} [pop3MaxDownload] How many bytes can be downloaded via POP3 during 24 hour
     * @apiParam {Number} [receivedMax] How many messages can be received from MX during 1 hour
     * @apiParam {Boolean} [disable2fa] If true, then disables 2FA for this user
     * @apiParam {Boolean} [disabled] If true then disables user account (can not login, can not receive messages)
     * @apiParam {String} [sess] Session identifier for the logs
     * @apiParam {String} [ip] IP address for the logs
     *
     * @apiSuccess {Boolean} success Indicates successful response
     *
     * @apiError error Description of the error
     *
     * @apiExample {curl} Example usage:
     *     curl -i -XPUT http://localhost:8080/users/59fc66a03e54454869460e45 \
     *     -H 'Content-type: application/json' \
     *     -d '{
     *       "name": "Updated user name"
     *     }'
     *
     * @apiSuccessExample {json} Success-Response:
     *     HTTP/1.1 200 OK
     *     {
     *       "success": true
     *     }
     *
     * @apiErrorExample {json} Error-Response:
     *     HTTP/1.1 200 OK
     *     {
     *       "error": "This user does not exist"
     *     }
     */
    server.put(
        '/users/:user',
        tools.asyncifyJson(async (req, res, next) => {
            res.charSet('utf-8');

            const schema = Joi.object().keys({
                user: Joi.string()
                    .hex()
                    .lowercase()
                    .length(24)
                    .required(),

                existingPassword: Joi.string()
                    .empty('')
                    .min(1)
                    .max(256),
                password: Joi.string()
                    .min(8)
                    .max(256)
                    .allow(false),

                language: Joi.string()
                    .min(2)
                    .max(20)
                    .lowercase(),

                name: Joi.string()
                    .empty('')
                    .max(256),
                targets: Joi.array().items(
                    Joi.string().email(),
                    Joi.string().uri({
                        scheme: [/smtps?/, /https?/],
                        allowRelative: false,
                        relativeOnly: false
                    })
                ),

                spamLevel: Joi.number()
                    .min(0)
                    .max(100),

                pubKey: Joi.string()
                    .empty('')
                    .trim()
                    .regex(/^-----BEGIN PGP PUBLIC KEY BLOCK-----/, 'PGP key format'),
                encryptMessages: Joi.boolean()
                    .empty('')
                    .truthy(['Y', 'true', 'yes', 'on', 1])
                    .falsy(['N', 'false', 'no', 'off', 0, '']),
                encryptForwarded: Joi.boolean()
                    .empty('')
                    .truthy(['Y', 'true', 'yes', 'on', 1])
                    .falsy(['N', 'false', 'no', 'off', 0, '']),
                retention: Joi.number().min(0),
                quota: Joi.number().min(0),
                recipients: Joi.number().min(0),
                forwards: Joi.number().min(0),

                imapMaxUpload: Joi.number().min(0),
                imapMaxDownload: Joi.number().min(0),
                pop3MaxDownload: Joi.number().min(0),
                receivedMax: Joi.number().min(0),

                disable2fa: Joi.boolean()
                    .empty('')
                    .truthy(['Y', 'true', 'yes', 'on', 1])
                    .falsy(['N', 'false', 'no', 'off', 0, '']),

                tags: Joi.array().items(
                    Joi.string()
                        .trim()
                        .max(128)
                ),

                disabled: Joi.boolean()
                    .empty('')
                    .truthy(['Y', 'true', 'yes', 'on', 1])
                    .falsy(['N', 'false', 'no', 'off', 0, '']),
                sess: Joi.string().max(255),
                ip: Joi.string().ip({
                    version: ['ipv4', 'ipv6'],
                    cidr: 'forbidden'
                })
            });

            const result = Joi.validate(req.params, schema, {
                abortEarly: false,
                convert: true
            });

            if (result.error) {
                res.json({
                    error: result.error.message,
                    code: 'InputValidationError'
                });
                return next();
            }

            // permissions check
            if (req.user && req.user === result.value.user) {
                req.validate(roles.can(req.role).updateOwn('users'));
            } else {
                req.validate(roles.can(req.role).updateAny('users'));
            }

            let user = new ObjectID(result.value.user);

            let targets = result.value.targets;

            if (targets) {
                for (let i = 0, len = targets.length; i < len; i++) {
                    let target = targets[i];
                    if (!/^smtps?:/i.test(target) && !/^https?:/i.test(target) && target.indexOf('@') >= 0) {
                        // email
                        targets[i] = {
                            id: new ObjectID(),
                            type: 'mail',
                            value: target
                        };
                    } else if (/^smtps?:/i.test(target)) {
                        targets[i] = {
                            id: new ObjectID(),
                            type: 'relay',
                            value: target
                        };
                    } else if (/^https?:/i.test(target)) {
                        targets[i] = {
                            id: new ObjectID(),
                            type: 'http',
                            value: target
                        };
                    } else {
                        res.json({
                            error: 'Unknown target type "' + target + '"',
                            code: 'InputValidationError'
                        });
                        return next();
                    }
                }

                result.value.targets = targets;
            }

            if (!result.value.name && 'name' in req.params) {
                result.value.name = '';
            }

            if (!result.value.pubKey && 'pubKey' in req.params) {
                result.value.pubKey = '';
            }

            if (result.value.tags) {
                let tagSeen = new Set();
                let tags = result.value.tags
                    .map(tag => tag.trim())
                    .filter(tag => {
                        if (tag && !tagSeen.has(tag.toLowerCase())) {
                            tagSeen.add(tag.toLowerCase());
                            return true;
                        }
                        return false;
                    })
                    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
                result.value.tags = tags;
                result.value.tagsview = tags.map(tag => tag.toLowerCase());
            }

            try {
                await checkPubKey(result.value.pubKey);
            } catch (err) {
                res.json({
                    error: 'PGP key validation failed. ' + err.message,
                    code: 'InputValidationError'
                });
                return next();
            }

            let success;
            try {
                success = await updateUser(user, result.value);
            } catch (err) {
                res.json({
                    error: err.message,
                    code: err.code
                });
                return next();
            }

            res.json({
                success
            });
            return next();
        })
    );

    /**
     * @api {put} /users/:id/logout Log out User
     * @apiName PutUserLogout
     * @apiGroup Users
     * @apiDescription This method logs out all user sessions in IMAP
     * @apiHeader {String} X-Access-Token Optional access token if authentication is enabled
     * @apiHeaderExample {json} Header-Example:
     * {
     *   "X-Access-Token": "59fc66a03e54454869460e45"
     * }
     *
     * @apiParam {String} id Users unique ID.
     * @apiParam {String} [reason] Message to be shown to connected IMAP client
     *
     * @apiSuccess {Boolean} success Indicates successful response
     *
     * @apiError error Description of the error
     *
     * @apiExample {curl} Example usage:
     *     curl -i -XPUT http://localhost:8080/users/59fc66a03e54454869460e45/logout \
     *     -H 'Content-type: application/json' \
     *     -d '{
     *       "reason": "Logout requested from API"
     *     }'
     *
     * @apiSuccessExample {json} Success-Response:
     *     HTTP/1.1 200 OK
     *     {
     *       "success": true
     *     }
     *
     * @apiErrorExample {json} Error-Response:
     *     HTTP/1.1 200 OK
     *     {
     *       "error": "This user does not exist"
     *     }
     */
    server.put(
        '/users/:user/logout',
        tools.asyncifyJson(async (req, res, next) => {
            res.charSet('utf-8');

            const schema = Joi.object().keys({
                user: Joi.string()
                    .hex()
                    .lowercase()
                    .length(24)
                    .required(),
                reason: Joi.string()
                    .empty('')
                    .max(128),
                sess: Joi.string().max(255),
                ip: Joi.string().ip({
                    version: ['ipv4', 'ipv6'],
                    cidr: 'forbidden'
                })
            });

            const result = Joi.validate(req.params, schema, {
                abortEarly: false,
                convert: true
            });

            if (result.error) {
                res.json({
                    error: result.error.message,
                    code: 'InputValidationError'
                });
                return next();
            }

            // permissions check
            if (req.user && req.user === result.value.user) {
                req.validate(roles.can(req.role).readOwn('users'));
            } else {
                req.validate(roles.can(req.role).readAny('users'));
            }

            let success;
            try {
                success = await logoutUser(result.value.user, result.value.reason || 'Logout requested from API');
            } catch (err) {
                res.json({
                    error: err.message,
                    code: err.code
                });
                return next();
            }

            res.json({
                success
            });
            return next();
        })
    );

    /**
     * @api {post} /users/:id/quota/reset Recalculate User quota
     * @apiName PostUserQuota
     * @apiGroup Users
     * @apiDescription This method recalculates quota usage for an User. Normally not needed, only use it if quota numbers are way off.
     * This method is not transactional, so if the user is currently receiving new messages then the resulting value is not exact.
     * @apiHeader {String} X-Access-Token Optional access token if authentication is enabled
     * @apiHeaderExample {json} Header-Example:
     * {
     *   "X-Access-Token": "59fc66a03e54454869460e45"
     * }
     *
     * @apiParam {String} id Users unique ID.
     * @apiParam {String} [reason] Message to be shown to connected IMAP client
     *
     * @apiSuccess {Boolean} success Indicates successful response
     * @apiSuccess {Number} storageUsed Calculated quota usage for the user
     *
     * @apiError error Description of the error
     *
     * @apiExample {curl} Example usage:
     *     curl -i -XPOST http://localhost:8080/users/59fc66a03e54454869460e45/quota/reset \
     *     -H 'Content-type: application/json' \
     *     -d '{}'
     *
     * @apiSuccessExample {json} Success-Response:
     *     HTTP/1.1 200 OK
     *     {
     *       "success": true,
     *       "storageUsed": 1234567
     *     }
     *
     * @apiErrorExample {json} Error-Response:
     *     HTTP/1.1 200 OK
     *     {
     *       "error": "This user does not exist"
     *     }
     */
    server.post(
        '/users/:user/quota/reset',
        tools.asyncifyJson(async (req, res, next) => {
            res.charSet('utf-8');

            const schema = Joi.object().keys({
                user: Joi.string()
                    .hex()
                    .lowercase()
                    .length(24)
                    .required(),
                sess: Joi.string().max(255),
                ip: Joi.string().ip({
                    version: ['ipv4', 'ipv6'],
                    cidr: 'forbidden'
                })
            });

            const result = Joi.validate(req.params, schema, {
                abortEarly: false,
                convert: true
            });

            if (result.error) {
                res.json({
                    error: result.error.message,
                    code: 'InputValidationError'
                });
                return next();
            }

            // permissions check
            if (req.user && req.user === result.value.user) {
                req.validate(roles.can(req.role).updateOwn('users'));
            } else {
                req.validate(roles.can(req.role).updateAny('users'));
            }

            let user = new ObjectID(result.value.user);

            let userData;
            try {
                userData = await db.users.collection('users').findOne(
                    {
                        _id: user
                    },
                    {
                        projection: {
                            storageUsed: true
                        }
                    }
                );
            } catch (err) {
                res.json({
                    error: 'MongoDB Error: ' + err.message,
                    code: 'InternalDatabaseError'
                });
                return next();
            }

            if (!userData) {
                res.json({
                    error: 'This user does not exist',
                    code: 'UserNotFound'
                });
                return next();
            }

            let storageData;
            try {
                // calculate mailbox size by aggregating the size's of all messages
                // NB! Scattered query
                storageData = db.database
                    .collection('messages')
                    .aggregate(
                        [
                            {
                                $match: {
                                    user
                                }
                            },
                            {
                                $group: {
                                    _id: {
                                        user: '$user'
                                    },
                                    storageUsed: {
                                        $sum: '$size'
                                    }
                                }
                            }
                        ],
                        {
                            cursor: {
                                batchSize: 1
                            }
                        }
                    )
                    .toArray();
            } catch (err) {
                res.json({
                    error: 'MongoDB Error: ' + err.message,
                    code: 'InternalDatabaseError'
                });
                return next();
            }

            let storageUsed = (storageData && storageData[0] && storageData[0].storageUsed) || 0;

            let updateResponse;
            try {
                // update quota counter
                updateResponse = await db.users.collection('users').findOneAndUpdate(
                    {
                        _id: userData._id
                    },
                    {
                        $set: {
                            storageUsed: Number(storageUsed) || 0
                        }
                    },
                    {
                        returnOriginal: false,
                        projection: {
                            storageUsed: true
                        }
                    }
                );
            } catch (err) {
                res.json({
                    error: 'MongoDB Error: ' + err.message,
                    code: 'InternalDatabaseError'
                });
                return next();
            }

            if (!updateResponse || !updateResponse.value) {
                res.json({
                    error: 'This user does not exist',
                    code: 'UserNotFound'
                });
                return next();
            }

            res.json({
                success: true,
                storageUsed: Number(updateResponse.value.storageUsed) || 0
            });
            return next();
        })
    );

    /**
     * @api {post} /users/:id/password/reset Reset password for an User
     * @apiName ResetUserPassword
     * @apiGroup Users
     * @apiDescription This method generates a new temporary password for an User.
     * Additionally it removes all two-factor authentication settings
     *
     * @apiHeader {String} X-Access-Token Optional access token if authentication is enabled
     * @apiHeaderExample {json} Header-Example:
     * {
     *   "X-Access-Token": "59fc66a03e54454869460e45"
     * }
     *
     * @apiParam {String} id Users unique ID.
     * @apiParam {String} [validAfter] Allow using the generated password not earlier than provided time
     * @apiParam {String} [sess] Session identifier for the logs
     * @apiParam {String} [ip] IP address for the logs
     *
     * @apiSuccess {Boolean} success Indicates successful response
     * @apiSuccess {String} password Temporary password
     *
     * @apiError error Description of the error
     *
     * @apiExample {curl} Example usage:
     *     curl -i -XPOST http://localhost:8080/users/5a1bda70bfbd1442cd96/password/reset \
     *     -H 'Content-type: application/json' \
     *     -d '{
     *       "ip": "127.0.0.1"
     *     }'
     *
     * @apiSuccessExample {json} Success-Response:
     *     HTTP/1.1 200 OK
     *     {
     *       "success": true,
     *       "password": "temporarypass"
     *     }
     *
     * @apiErrorExample {json} Error-Response:
     *     HTTP/1.1 200 OK
     *     {
     *       "error": "This user does not exist"
     *     }
     */
    server.post(
        '/users/:user/password/reset',
        tools.asyncifyJson(async (req, res, next) => {
            res.charSet('utf-8');

            const schema = Joi.object().keys({
                user: Joi.string()
                    .hex()
                    .lowercase()
                    .length(24)
                    .required(),
                validAfter: Joi.date()
                    .empty('')
                    .allow(false),
                sess: Joi.string().max(255),
                ip: Joi.string().ip({
                    version: ['ipv4', 'ipv6'],
                    cidr: 'forbidden'
                })
            });

            const result = Joi.validate(req.params, schema, {
                abortEarly: false,
                convert: true
            });

            if (result.error) {
                res.json({
                    error: result.error.message,
                    code: 'InputValidationError'
                });
                return next();
            }

            // permissions check
            req.validate(roles.can(req.role).updateAny('users'));

            let user = new ObjectID(result.value.user);

            let password;
            try {
                password = await resetUser(user, result.value);
            } catch (err) {
                res.json({
                    error: err.message,
                    code: err.code
                });
                return next();
            }

            res.json({
                success: true,
                password,
                validAfter: (result.value && result.value.validAfter) || new Date()
            });
            return next();
        })
    );

    /**
     * @api {delete} /users/:id Delete an User
     * @apiName DeleteUser
     * @apiGroup Users
     * @apiHeader {String} X-Access-Token Optional access token if authentication is enabled
     * @apiHeaderExample {json} Header-Example:
     * {
     *   "X-Access-Token": "59fc66a03e54454869460e45"
     * }
     *
     * @apiParam {String} id Users unique ID.
     * @apiParam {String} [sess] Session identifier for the logs
     * @apiParam {String} [ip] IP address for the logs
     *
     * @apiSuccess {Boolean} success Indicates successful response
     *
     * @apiError error Description of the error
     *
     * @apiExample {curl} Example usage:
     *     curl -i -XDELETE http://localhost:8080/users/5a1bda70bfbd1442cd96c6f0?ip=127.0.0.1
     *
     * @apiSuccessExample {json} Success-Response:
     *     HTTP/1.1 200 OK
     *     {
     *       "success": true
     *     }
     *
     * @apiErrorExample {json} Error-Response:
     *     HTTP/1.1 200 OK
     *     {
     *       "error": "This user does not exist"
     *     }
     */
    server.del(
        '/users/:user',
        tools.asyncifyJson(async (req, res, next) => {
            res.charSet('utf-8');

            const schema = Joi.object().keys({
                user: Joi.string()
                    .hex()
                    .lowercase()
                    .length(24)
                    .required(),
                sess: Joi.string().max(255),
                ip: Joi.string().ip({
                    version: ['ipv4', 'ipv6'],
                    cidr: 'forbidden'
                })
            });

            if (req.query.sess) {
                req.params.sess = req.query.sess;
            }

            if (req.query.ip) {
                req.params.ip = req.query.ip;
            }

            const result = Joi.validate(req.params, schema, {
                abortEarly: false,
                convert: true
            });

            if (result.error) {
                res.json({
                    error: result.error.message,
                    code: 'InputValidationError'
                });
                return next();
            }

            // permissions check
            req.validate(roles.can(req.role).deleteAny('users'));

            let user = new ObjectID(result.value.user);

            let status;
            try {
                status = await deleteUser(user, {});
            } catch (err) {
                res.json({
                    error: err.message,
                    code: err.code
                });
                return next();
            }
            res.json({
                success: status
            });
            return next();
        })
    );
};

async function getKeyInfo(pubKey) {
    if (!pubKey) {
        return false;
    }

    // try to encrypt something with that key
    let armored;
    try {
        armored = (await openpgp.key.readArmored(pubKey)).keys;
    } catch (E) {
        return false;
    }

    if (!armored || !armored[0]) {
        return false;
    }

    let fingerprint = armored[0].primaryKey.fingerprint;
    let name, address;
    if (armored && armored[0] && armored[0].users && armored[0].users[0] && armored[0].users[0].userId) {
        let user = addressparser(armored[0].users[0].userId.userid);
        if (user && user[0] && user[0].address) {
            address = tools.normalizeAddress(user[0].address);
            try {
                name = libmime.decodeWords(user[0].name || '').trim();
            } catch (E) {
                // failed to parse value
                name = user[0].name || '';
            }
        }
    }

    return {
        name,
        address,
        fingerprint
    };
}

async function checkPubKey(pubKey) {
    if (!pubKey) {
        return false;
    }

    // try to encrypt something with that key
    let armored = (await openpgp.key.readArmored(pubKey)).keys;

    if (!armored || !armored[0]) {
        throw new Error('Did not find key information');
    }

    let fingerprint = armored[0].primaryKey.fingerprint;
    let name, address;
    if (armored && armored[0] && armored[0].users && armored[0].users[0] && armored[0].users[0].userId) {
        let user = addressparser(armored[0].users[0].userId.userid);
        if (user && user[0] && user[0].address) {
            address = tools.normalizeAddress(user[0].address);
            try {
                name = libmime.decodeWords(user[0].name || '').trim();
            } catch (E) {
                // failed to parse value
                name = user[0].name || '';
            }
        }
    }

    let ciphertext = await openpgp.encrypt({
        message: openpgp.message.fromText('Hello, World!'),
        publicKeys: armored
    });

    if (/^-----BEGIN PGP MESSAGE/.test(ciphertext.data)) {
        // everything checks out
        return {
            address,
            name,
            fingerprint
        };
    }

    throw new Error('Unexpected message');
}
