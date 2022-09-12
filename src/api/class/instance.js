/* eslint-disable no-unsafe-optional-chaining */
const QRCode = require('qrcode')
const pino = require('pino')
const {
    default: makeWASocket,
    DisconnectReason,
    delay,
    getDevice,
} = require('@adiwajshing/baileys')
const { unlinkSync, readFileSync } = require('fs')
const { v4: uuidv4 } = require('uuid')
const path = require('path')
const processButton = require('../helper/processbtn')
const generateVC = require('../helper/genVc')
const Chat = require('../models/chat.model')
const axios = require('axios')
const config = require('../../config/config')
const downloadMessage = require('../helper/downloadMsg')
const logger = require('pino')()
const useMongoDBAuthState = require('../helper/mongoAuthState')

class WhatsAppInstance {
    socketConfig = {
        defaultQueryTimeoutMs: undefined,
        printQRInTerminal: false,
        logger: pino({
            level: config.log.level,
        }),
    }
    key = ''
    authState
    allowWebhook = undefined
    webhook = undefined

    instance = {
        key: this.key,
        chats: [],
        qr: '',
        messages: [],
        qrRetry: 0,
        customWebhook: '',
    }

    axiosInstance = axios.create({
        baseURL: config.webhookUrl,
    })

    constructor(key, allowWebhook, webhook) {
        this.key = key ? key : uuidv4()
        this.instance.customWebhook = this.webhook ? this.webhook : webhook
        this.allowWebhook = config.webhookEnabled
            ? config.webhookEnabled
            : allowWebhook
        if (this.allowWebhook && this.instance.customWebhook !== null) {
            this.allowWebhook = true
            this.instance.customWebhook = webhook
            this.axiosInstance = axios.create({
                baseURL: webhook,
            })
        }
    }

//    async SendWebhook(type, body) {
//        if (!this.allowWebhook) return
//        this.axiosInstance
//            .post('', {
//                type,
//                body
//            })
//            .catch(() => {})
//    }

    async SendWebhook(type, body) {
        if (!this.allowWebhook) return
        this.axiosInstance
            .post('', {
                type,
                body,
                instance_key: this.key,
                bearer_token: config.token,
                api_url: config.appUrl,
            })
            .catch(() => {})
    }

    async init() {
        this.collection = mongoClient.db('whatsapp-api').collection(this.key)
        const { state, saveCreds } = await useMongoDBAuthState(this.collection)
        this.authState = { state: state, saveCreds: saveCreds }
        this.socketConfig.auth = this.authState.state
        this.socketConfig.browser = Object.values(config.browser)
        this.instance.sock = makeWASocket(this.socketConfig)
        this.setHandler()
        return this
    }

    setHandler() {
        const sock = this.instance.sock
        // on credentials update save state
        sock?.ev.on('creds.update', this.authState.saveCreds)

        // on socket closed, opened, connecting
        sock?.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update

            if (connection === 'connecting') return

            if (connection === 'close') {
                // reconnect if not logged out
                if (
                    lastDisconnect?.error?.output?.statusCode !==
                    DisconnectReason.loggedOut
                ) {
                    await this.init()
                } else {
                    await this.collection.drop().then((r) => {
                        logger.info('STATE: Droped collection')
                    })
                    this.instance.online = false
                }

                if (config.webhookConnection) {
                    await this.SendWebhook('connection', {
                        data: connection
                    })
                }
            } else if (connection === 'open') {
                if (config.mongoose.enabled) {
                    let alreadyThere = await Chat.findOne({
                        key: this.key,
                    }).exec()
                    if (!alreadyThere) {
                        const saveChat = new Chat({ key: this.key })
                        await saveChat.save()
                    }
                }
                this.instance.online = true

                if (config.webhookConnection) {
                    await this.SendWebhook('connection', {
                        data: connection
                    })
                }
            }

            if (qr) {
                QRCode.toDataURL(qr).then((url) => {
                    this.instance.qr = url
                    this.instance.qrRetry++
                    if (this.instance.qrRetry >= config.instance.maxRetryQr) {
                        // close WebSocket connection
                        this.instance.sock.ws.close()
                        // remove all events
                        this.instance.sock.ev.removeAllListeners()
                        this.instance.qr = ' '
                        logger.info('socket connection terminated')
                    }
                })
            }
        })

        // sending presence
        sock?.ev.on('presence.update', async (json) => {
            if (config.webhookPresence) {
                await this.SendWebhook('presence', json)
            }
        })

        // on receive all chats
        sock?.ev.on('chats.set', async ({ chats }) => {
            const recivedChats = chats.map((chat) => {
                return {
                    ...chat,
                    messages: [],
                }
            })
            this.instance.chats.push(...recivedChats)
            await this.updateDb(this.instance.chats)
            await this.updateDbGroupsParticipants()
        })

        // on recive new chat
        sock?.ev.on('chats.upsert', (newChat) => {
            //console.log('chats.upsert')
            //console.log(newChat)
            const chats = newChat.map((chat) => {
                return {
                    ...chat,
                    messages: [],
                }
            })
            this.instance.chats.push(...chats)
        })

        // on chat change
        sock?.ev.on('chats.update', (changedChat) => {
            //console.log('chats.update')
            //console.log(changedChat)
            changedChat.map((chat) => {
                const index = this.instance.chats.findIndex(
                    (pc) => pc.id === chat.id
                )
                const PrevChat = this.instance.chats[index]
                this.instance.chats[index] = {
                    ...PrevChat,
                    ...chat,
                }
            })
        })

        // on chat delete
        sock?.ev.on('chats.delete', (deletedChats) => {
            //console.log('chats.delete')
            //console.log(deletedChats)
            deletedChats.map((chat) => {
                const index = this.instance.chats.findIndex(
                    (c) => c.id === chat
                )
                this.instance.chats.splice(index, 1)
            })
        })

        // on new message
        sock?.ev.on('messages.upsert', (m) => {
            //console.log('messages.upsert')
            //console.log(m)
            //console.log(m.messages[0]['key']['id'])
            //console.log(getDevice(m.messages[0]['key']['id']))

            if (m.type === 'prepend')
                this.instance.messages.unshift(...m.messages)
            if (m.type !== 'notify') return

            let userDevice = getDevice(m.messages[0]['key']['id'])

            this.instance.messages.unshift(...m.messages)

            m.messages.map(async (msg) => {
                if (!msg.message) return

                const messageType = Object.keys(msg.message)[0]
                if (
                    [
                        'protocolMessage',
                        'senderKeyDistributionMessage',
                    ].includes(messageType)
                )
                    return

                const webhookData = {
                    key: this.key,
                    userDevice: userDevice,
                    ...msg,
                }

                if (messageType === 'conversation') {
                    webhookData['text'] = m
                }
                if (config.webhookBase64) {
                    switch (messageType) {
                        case 'imageMessage':
                            webhookData['msgContent'] = await downloadMessage(
                                msg.message.imageMessage,
                                'image'
                            )
                            break
                        case 'videoMessage':
                            webhookData['msgContent'] = await downloadMessage(
                                msg.message.videoMessage,
                                'video'
                            )
                            break
                        case 'audioMessage':
                            webhookData['msgContent'] = await downloadMessage(
                                msg.message.audioMessage,
                                'audio'
                            )
                            break
                        default:
                            webhookData['msgContent'] = ''
                            break
                    }
                }

                if (config.webhookMessage) {
                    await this.SendWebhook('message', webhookData)
                }
            })
        })

        sock?.ev.on('messages.update', async (messages) => {
            //console.log('messages.update')
            //console.dir(messages);
            if (config.webhookUpdate) {
                await this.SendWebhook('messages.update', {
                    data: messages
                })
            }
        })

        sock?.ws.on('CB:call', async (data) => {
            if (data.content) {
                if (data.content.find((e) => e.tag === 'offer')) {
                    const content = data.content.find((e) => e.tag === 'offer')

                    if (config.webhookCall) {
                        await this.SendWebhook('call_offer', {
                            id: content.attrs['call-id'],
                            timestamp: parseInt(data.attrs.t),
                            user: {
                                id: data.attrs.from,
                                platform: data.attrs.platform,
                                platform_version: data.attrs.version,
                            },
                        })
                    }
                } else if (data.content.find((e) => e.tag === 'terminate')) {
                    const content = data.content.find(
                        (e) => e.tag === 'terminate'
                    )

                    if (config.webhookCall) {
                        await this.SendWebhook('call_terminate', {
                            id: content.attrs['call-id'],
                            user: {
                                id: data.attrs.from,
                            },
                            timestamp: parseInt(data.attrs.t),
                            reason: data.content[0].attrs.reason,
                        })
                    }
                }
            }
        })

        sock?.ev.on('groups.upsert', async (newChat) => {
            //console.log('groups.upsert')
            //console.log(newChat)
            this.createGroupByApp(newChat)
            if (config.webhookGroup) {
                await this.SendWebhook('group_created', {
                    data: newChat,
                })
            }
        })

        sock?.ev.on('groups.update', async (newChat) => {
            //console.log('groups.update')
            //console.log(newChat)
            this.updateGroupSubjectByApp(newChat)
            if (config.webhookGroup) {
                await this.SendWebhook('group_updated', {
                    data: newChat,
                })
            }
        })

        sock?.ev.on('group-participants.update', async (newChat) => {
            //console.log('group-participants.update')
            //console.log(newChat)
            this.updateGroupParticipantsByApp(newChat)
            if (config.webhookGroup) {
                await this.SendWebhook('group_participants_updated', {
                    data: newChat,
                })
            } 
        })
    }

    async getInstanceDetail(key) {
        return {
            instance_key: key,
            phone_connected: this.instance?.online,
            webhookUrl: this.instance.customWebhook,
            user: this.instance?.online ? this.instance.sock?.user : {},
        }
    }

//    getWhatsAppId(id) {
//        if (id.includes('@g.us') || id.includes('@s.whatsapp.net')) return id
//        return id.includes('-') ? `${id}@g.us` : `${id}@s.whatsapp.net`
//    }

    getWhatsAppId(id) {

        const numberDDI = id.substr(0, 2);
        const numberDDD = id.substr(2, 2);
        const numberUser = id.substr(-8, 8);

        if (numberDDI !== '55') {
            if (id.includes('@g.us') || id.includes('@s.whatsapp.net')) return id
            return id.includes('-') ? `${id}@g.us` : `${id}@s.whatsapp.net`
        }

        if (numberDDI === '55' && numberDDD <= 30) {
            const id = numberDDI + numberDDD + "9" + numberUser;
            if (id.includes('@g.us') || id.includes('@s.whatsapp.net')) return id
            return id.includes('-') ? `${id}@g.us` : `${id}@s.whatsapp.net`

        }

        if (numberDDI === '55' && numberDDD > 30) {
            const id = numberDDI + numberDDD + numberUser;
            if (id.includes('@g.us') || id.includes('@s.whatsapp.net')) return id
            return id.includes('-') ? `${id}@g.us` : `${id}@s.whatsapp.net`
        }

    }

    async verifyId(id) {
        if (id.includes('@g.us')) return true
        const [result] = await this.instance.sock?.onWhatsApp(id)
        if (result?.exists) return true
        throw new Error('no account exists')
    }

    async sendTextMessage(to, msdelay, message) {
        await this.verifyId(this.getWhatsAppId(to))
        await this.instance.sock?.sendPresenceUpdate('composing', this.getWhatsAppId(to))
        await delay(msdelay)
        const data = await this.instance.sock?.sendMessage(
            this.getWhatsAppId(to),
            { 
            		text: message 
            }
        )
        return data
    }

    async sendMediaFile(to, msdelay, path, file, type, caption = '', mimetype) {
        await this.verifyId(this.getWhatsAppId(to))
        if (type === 'audio')
            {
                await this.instance.sock?.sendPresenceUpdate('recording', this.getWhatsAppId(to))
            }
        else
        	  {
                await this.instance.sock?.sendPresenceUpdate('composing', this.getWhatsAppId(to))
            }
        await delay(msdelay)
        const data = await this.instance.sock?.sendMessage(
            this.getWhatsAppId(to),
            {
                [type]: { url: path + file },
                mimetype: mimetype,
                caption: caption,
                ptt: type === 'audio' ? true : false
            }
        )
        return data
    }

    async sendMediaPix(to, base64code, caption = '') {
        await this.verifyId(this.getWhatsAppId(to))
        const data = await this.instance.sock?.sendMessage(
            this.getWhatsAppId(to),
            {
                image: Buffer.from(base64code, "base64"),
                mimetype: "image/png"
            },
        );
        return data;
    }

    async sendDocFile(to, msdelay, path, file, type, caption = '', mimetype, filename) {
        await this.verifyId(this.getWhatsAppId(to))
        await this.instance.sock?.sendPresenceUpdate('composing', this.getWhatsAppId(to))
        await delay(msdelay)
        const data = await this.instance.sock?.sendMessage(
            this.getWhatsAppId(to),
            {
                mimetype: mimetype,
                [type]: { url: path + file },
                caption: caption,
                fileName: filename ? filename : file
            }
        )
        return data
    }

    async sendLinkMessage(to, msdelay, textbefore = '', url, textafter = '', title, description, path, file) {
        await this.verifyId(this.getWhatsAppId(to))
        await this.instance.sock?.sendPresenceUpdate('composing', this.getWhatsAppId(to))
        await delay(msdelay)
        const result = await this.instance.sock?.sendMessage(
            this.getWhatsAppId(to),
            { 
		            text: textbefore + ' ' + url + ' ' + textafter,
		            matchedText: url,
		            canonicalUrl: url,
		            title: title,
		            description: description,
		            jpegThumbnail: readFileSync(path + file)
            }
        )
        return result
    }

    async sendUrlMediaFile(to, msdelay, url, type, mimeType, caption = '', filename = 'file') {
        await this.verifyId(this.getWhatsAppId(to))
        await this.instance.sock?.sendPresenceUpdate('composing', this.getWhatsAppId(to))
        await delay(msdelay)
        const data = await this.instance.sock?.sendMessage(
            this.getWhatsAppId(to),
            {
                [type]: {
                    url: url,
                },
                caption: caption,
                mimetype: mimeType,
                fileName: filename
            }
        )
        return data
    }

    async DownloadProfile(of) {
        await this.verifyId(this.getWhatsAppId(of))
        const ppUrl = await this.instance.sock?.profilePictureUrl(
            this.getWhatsAppId(of),
            'image'
        )
        return ppUrl
    }

    async getUserStatus(of) {
        await this.verifyId(this.getWhatsAppId(of))
        const status = await this.instance.sock?.fetchStatus(
            this.getWhatsAppId(of)
        )
        return status
    }

    async blockUnblock(to, data) {
        await this.verifyId(this.getWhatsAppId(to))
        const status = await this.instance.sock?.updateBlockStatus(
            this.getWhatsAppId(to),
            data
        )
        return status
    }

    async sendSimpleButtonMessage(to, msdelay, data) {
        await this.verifyId(this.getWhatsAppId(to))
        await this.instance.sock?.sendPresenceUpdate('composing', this.getWhatsAppId(to))
        await delay(msdelay)
        const result = await this.instance.sock?.sendMessage(
            this.getWhatsAppId(to),
            {
                buttons: data.buttons ?? '',
                text: data.text ?? '',
                footer: data.footer ?? '',
                headerType: data.headerType ?? 1
            }
        )
        return result
    }

    async sendContactMessage(to, msdelay, data) {
        await this.verifyId(this.getWhatsAppId(to))
        await this.instance.sock?.sendPresenceUpdate('composing', this.getWhatsAppId(to))
        await delay(msdelay)
        const vcard = generateVC(data)
        const result = await this.instance.sock?.sendMessage(
            await this.getWhatsAppId(to),
            {
                contacts: {
                    displayName: data.fullName,
                    contacts: [{ displayName: data.fullName, vcard }],
                }
            }
        )
        return result
    }

    async sendListMessage(to, msdelay, data) {
        await this.verifyId(this.getWhatsAppId(to))
        await this.instance.sock?.sendPresenceUpdate('composing', this.getWhatsAppId(to))
        await delay(msdelay)
        const result = await this.instance.sock?.sendMessage(
            this.getWhatsAppId(to),
            {
                text: data.text,
                sections: data.sections,
                buttonText: data.buttonText,
                footer: data.description,
                title: data.title
            }
        )
        return result
    }

    async sendMediaButtonMessage(to, msdelay, data) {
        await this.verifyId(this.getWhatsAppId(to))
        await this.instance.sock?.sendPresenceUpdate('composing', this.getWhatsAppId(to))
        await delay(msdelay)
        const result = await this.instance.sock?.sendMessage(
            this.getWhatsAppId(to),
            {
                [data.mediaType]: {
                    url: data.path + data.image,
                },
                footer: data.footerText ?? '',
                caption: data.text,
                templateButtons: processButton(data.buttons),                
                mimetype: data.mimeType
            }
        )
        return result
    }

    async sendTemplateButtonMessage(to, msdelay, data) {
        await this.verifyId(this.getWhatsAppId(to))
        await this.instance.sock?.sendPresenceUpdate('composing', this.getWhatsAppId(to))
        await delay(msdelay)
        const result = await this.instance.sock?.sendMessage(
            this.getWhatsAppId(to),
            {
                templateButtons: processButton(data.buttons),
                text: data.text ?? '',
                footer: data.footerText ?? ''
            }
        )
        return result
    }

    async sendLocationMessage(to, msdelay, data) {
        await this.verifyId(this.getWhatsAppId(to))
        await this.instance.sock?.sendPresenceUpdate('composing', this.getWhatsAppId(to))
        await delay(msdelay)
        const result = await this.instance.sock?.sendMessage(
            this.getWhatsAppId(to),
            { 
            		location: 
            		{ 
            				degreesLatitude: data.latitude, 
            				degreesLongitude: data.longitude,
            				name: data.name,
            				address: data.address  
            		},
            }            
        )
        return result
    }

    async sendReactionMessage(to, data) {
        await this.verifyId(this.getWhatsAppId(to));
        const result = await this.instance.sock?.sendMessage(
            this.getWhatsAppId(to),
            { 
            		react: 
            		{ 
            				text: data.emoticon, 
            				key: {remoteJid: to, id: data.id, fromMe: false, participant: data.participant}
            		} 
            }
        )
        return result
    }

    async setStatus(status, to) {
        await this.verifyId(this.getWhatsAppId(to))

        const result = await this.instance.sock?.sendPresenceUpdate(status, to)
        return result
    }

    // change your display picture or a group's
    async updateProfilePicture(id, url) {
        try {
            const img = await axios.get(url, { responseType: 'arraybuffer' })
            const res = await this.instance.sock?.updateProfilePicture(
                id,
                img.data
            )
            return res
        } catch (e) {
            //console.log(e)
            return {
                error: true,
                message: 'Unable to update profile picture',
            }
        }
    }

    // get user or group object from db by id
    async getUserOrGroupById(id) {
        try {
            let Chats = await this.getChat()
            const group = Chats.find((c) => c.id === this.getWhatsAppId(id))
            if (!group)
                throw new Error(
                    'unable to get group, check if the group exists'
                )
            return group
        } catch (e) {
            logger.error(e)
            logger.error('Error get group failed')
        }
    }

    // Group Methods
    parseParticipants(users) {
        return users.map((users) => this.getWhatsAppId(users))
    }

    async updateDbGroupsParticipants() {
        try {
            let groups = await this.groupFetchAllParticipating()
            let Chats = await this.getChat()
            for (const [key, value] of Object.entries(groups)) {
                let participants = []
                for (const [key_participant, participant] of Object.entries(
                    value.participants
                )) {
                    participants.push(participant)
                }
                Chats.find((c) => c.id === key).creation = value.creation
                Chats.find((c) => c.id === key).subjectOwner =
                    value.subjectOwner
                Chats.find((c) => c.id === key).participant = participants
            }
            await this.updateDb(Chats)
        } catch (e) {
            logger.error(e)
            logger.error('Error updating groups failed')
        }
    }

    async createNewGroup(name, users) {
        try {
            const group = await this.instance.sock?.groupCreate(
                name,
                users.map(this.getWhatsAppId)
            )
            return group
        } catch (e) {
            logger.error(e)
            logger.error('Error create new group failed')
        }
    }

    async addNewParticipant(id, users) {
        try {
            const res = await this.instance.sock?.groupAdd(
                this.getWhatsAppId(id),
                this.parseParticipants(users)
            )
            return res
        } catch {
            return {
                error: true,
                message:
                    'Unable to add participant, you must be an admin in this group',
            }
        }
    }

    async makeAdmin(id, users) {
        try {
            const res = await this.instance.sock?.groupMakeAdmin(
                this.getWhatsAppId(id),
                this.parseParticipants(users)
            )
            return res
        } catch {
            return {
                error: true,
                message:
                    'unable to promote some participants, check if you are admin in group or participants exists',
            }
        }
    }

    async demoteAdmin(id, users) {
        try {
            const res = await this.instance.sock?.groupDemoteAdmin(
                this.getWhatsAppId(id),
                this.parseParticipants(users)
            )
            return res
        } catch {
            return {
                error: true,
                message:
                    'unable to demote some participants, check if you are admin in group or participants exists',
            }
        }
    }

    async getAllGroups() {
        let Chats = await this.getChat()
        return Chats.filter((c) => c.id.includes('@g.us')).map((data, i) => {
            return {
                index: i,
                name: data.name,
                jid: data.id,
                participant: data.participant,
                creation: data.creation,
                subjectOwner: data.subjectOwner,
            }
        })
    }

    async leaveGroup(id) {
        try {
            let Chats = await this.getChat()
            const group = Chats.find((c) => c.id === id)
            if (!group) throw new Error('no group exists')
            return await this.instance.sock?.groupLeave(id)
        } catch (e) {
            logger.error(e)
            logger.error('Error leave group failed')
        }
    }

    async getInviteCodeGroup(id) {
        try {
            let Chats = await this.getChat()
            const group = Chats.find((c) => c.id === id)
            if (!group)
                throw new Error(
                    'unable to get invite code, check if the group exists'
                )
            return await this.instance.sock?.groupInviteCode(id)
        } catch (e) {
            logger.error(e)
            logger.error('Error get invite group failed')
        }
    }

    // get Chat object from db
    async getChat(key = this.key) {
        let dbResult = await Chat.findOne({ key: key }).exec()
        let ChatObj = dbResult.chat
        return ChatObj
    }

    // create new group by application
    async createGroupByApp(newChat) {
        try {
            let Chats = await this.getChat()
            let group = {
                id: newChat[0].id,
                name: newChat[0].subject,
                participant: newChat[0].participants,
                messages: [],
                creation: newChat[0].creation,
                subjectOwner: newChat[0].subjectOwner,
            }
            Chats.push(group)
            await this.updateDb(Chats)
        } catch (e) {
            logger.error(e)
            logger.error('Error updating document failed')
        }
    }

    async updateGroupSubjectByApp(newChat) {
        //console.log(newChat)
        try {
            if (newChat[0] && newChat[0].subject) {
                let Chats = await this.getChat()
                Chats.find((c) => c.id === newChat[0].id).name =
                    newChat[0].subject
                await this.updateDb(Chats)
            }
        } catch (e) {
            logger.error(e)
            logger.error('Error updating document failed')
        }
    }

    async updateGroupParticipantsByApp(newChat) {
        //console.log(newChat)
        try {
            if (newChat && newChat.id) {
                let Chats = await this.getChat()
                let chat = Chats.find((c) => c.id === newChat.id)
                let is_owner = false
                if (chat.participant == undefined) {
                    chat.participant = []
                }
                if (chat.participant && newChat.action == 'add') {
                    for (const participant of newChat.participants) {
                        chat.participant.push({ id: participant, admin: null })
                    }
                }
                if (chat.participant && newChat.action == 'remove') {
                    for (const participant of newChat.participants) {
                        // remove group if they are owner
                        if (chat.subjectOwner == participant) {
                            is_owner = true
                        }
                        chat.participant = chat.participant.filter(
                            (p) => p.id != participant
                        )
                    }
                }
                if (chat.participant && newChat.action == 'demote') {
                    for (const participant of newChat.participants) {
                        if (
                            chat.participant.filter(
                                (p) => p.id == participant
                            )[0]
                        ) {
                            chat.participant.filter(
                                (p) => p.id == participant
                            )[0].admin = null
                        }
                    }
                }
                if (chat.participant && newChat.action == 'promote') {
                    for (const participant of newChat.participants) {
                        if (
                            chat.participant.filter(
                                (p) => p.id == participant
                            )[0]
                        ) {
                            chat.participant.filter(
                                (p) => p.id == participant
                            )[0].admin = 'superadmin'
                        }
                    }
                }
                if (is_owner) {
                    Chats = Chats.filter((c) => c.id !== newChat.id)
                } else {
                    Chats.filter((c) => c.id === newChat.id)[0] = chat
                }
                await this.updateDb(Chats)
            }
        } catch (e) {
            logger.error(e)
            logger.error('Error updating document failed')
        }
    }

    async groupFetchAllParticipating() {
        try {
            const result =
                await this.instance.sock?.groupFetchAllParticipating()
            return result
        } catch (e) {
            logger.error('Error group fetch all participating failed')
        }
    }

    // update promote demote remove
    async groupParticipantsUpdate(id, users, action) {
        try {
            const res = await this.instance.sock?.groupParticipantsUpdate(
                this.getWhatsAppId(id),
                this.parseParticipants(users),
                action
            )
            return res
        } catch (e) {
            //console.log(e)
            return {
                error: true,
                message:
                    'unable to ' +
                    action +
                    ' some participants, check if you are admin in group or participants exists',
            }
        }
    }

    // update group settings like
    // only allow admins to send messages
    async groupSettingUpdate(id, action) {
        try {
            const res = await this.instance.sock?.groupSettingUpdate(
                this.getWhatsAppId(id),
                action
            )
            return res
        } catch (e) {
            //console.log(e)
            return {
                error: true,
                message:
                    'unable to ' + action + ' check if you are admin in group',
            }
        }
    }

    async groupUpdateSubject(id, subject) {
        try {
            const res = await this.instance.sock?.groupUpdateSubject(
                this.getWhatsAppId(id),
                subject
            )
            return res
        } catch (e) {
            //console.log(e)
            return {
                error: true,
                message:
                    'unable to update subject check if you are admin in group',
            }
        }
    }

    async groupUpdateDescription(id, description) {
        try {
            const res = await this.instance.sock?.groupUpdateDescription(
                this.getWhatsAppId(id),
                description
            )
            return res
        } catch (e) {
            //console.log(e)
            return {
                error: true,
                message:
                    'unable to update description check if you are admin in group',
            }
        }
    }

    // update db document -> chat
    async updateDb(object) {
        try {
            await Chat.updateOne({ key: this.key }, { chat: object })
        } catch (e) {
            logger.error('Error updating document failed')
        }
    }
}

exports.WhatsAppInstance = WhatsAppInstance
