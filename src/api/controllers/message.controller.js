exports.Text = async (req, res) => {
    const data = await WhatsAppInstances[req.query.key].sendTextMessage(
        req.body.id,
        req.body.msdelay,
        req.body.message
    )
    return res.status(201).json({ error: false, data: data })
}

exports.Image = async (req, res) => {
    const data = await WhatsAppInstances[req.query.key].sendMediaFile(
        req.body.id,
        req.body.msdelay,
        req.body.path,
        req.body.file,
        'image',
        req.body?.caption,
        req.body.mimetype
    )
    return res.status(201).json({ error: false, data: data })
}

exports.Video = async (req, res) => {
    const data = await WhatsAppInstances[req.query.key].sendMediaFile(
        req.body.id,
        req.body.msdelay,
        req.body.path,
        req.body.file,
        'video',
        req.body?.caption,
        req.body.mimetype
    )
    return res.status(201).json({ error: false, data: data })
}

exports.Audio = async (req, res) => {
    const data = await WhatsAppInstances[req.query.key].sendMediaFile(
        req.body.id,
        req.body.msdelay,
        req.body.path,
        req.body.file,
        'audio',
        req.body.mimetype
    )
    return res.status(201).json({ error: false, data: data })
}

exports.Document = async (req, res) => {
    const data = await WhatsAppInstances[req.query.key].sendDocFile(
        req.body.id,
        req.body.msdelay,
        req.body.path,
        req.body.file,
        'document',
        '',
        req.body.mimetype,
        req.body.filename
    )
    return res.status(201).json({ error: false, data: data })
}

exports.Mediaurl = async (req, res) => {
    const data = await WhatsAppInstances[req.query.key].sendUrlMediaFile(
        req.body.id,
        req.body.msdelay,
        req.body.url,
        req.body.type, // Types are [image, video, audio, document]
        req.body.mimetype, // mimeType of mediaFile / Check Common mimetypes in `https://mzl.la/3si3and`
        req.body.caption,
        req.body.filename
    )
    return res.status(201).json({ error: false, data: data })
}

exports.Link = async (req, res) => {
    const data = await WhatsAppInstances[req.query.key].sendLinkMessage(
        req.body.id,
        req.body.msdelay,
        req.body.textbefore,
        req.body.url,
        req.body.textafter,
        req.body.title,
        req.body.description,
        req.body.path,
        req.body.file
    )
    return res.status(201).json({ error: false, data: data })
}

exports.SimpleButton = async (req, res) => {
    // console.log(res.body)
    const data = await WhatsAppInstances[req.query.key].sendSimpleButtonMessage(
        req.body.id,
        req.body.msdelay,
        req.body.btndata
    )
    return res.status(201).json({ error: false, data: data })
}

exports.TemplateButton = async (req, res) => {
    const data = await WhatsAppInstances[req.query.key].sendTemplateButtonMessage(
        req.body.id,
        req.body.msdelay,
        req.body.btndata
    )
    return res.status(201).json({ error: false, data: data })
}

exports.MediaButton = async (req, res) => {
    const data = await WhatsAppInstances[req.query.key].sendMediaButtonMessage(
        req.body.id,
        req.body.msdelay,
        req.body.btndata
    )
    return res.status(201).json({ error: false, data: data })
}

exports.List = async (req, res) => {
    const data = await WhatsAppInstances[req.query.key].sendListMessage(
        req.body.id,
        req.body.msdelay,
        req.body.msgdata
    )
    return res.status(201).json({ error: false, data: data })
}

exports.Contact = async (req, res) => {
    const data = await WhatsAppInstances[req.query.key].sendContactMessage(
        req.body.id,
        req.body.msdelay,
        req.body.vcard
    )
    return res.status(201).json({ error: false, data: data })
}

exports.Location = async (req, res) => {
    const data = await WhatsAppInstances[req.query.key].sendLocationMessage(
        req.body.id,
        req.body.msdelay,
        req.body.locdata
    )
    return res.status(201).json({ error: false, data: data })
}

exports.Reaction = async (req, res) => {
    const data = await WhatsAppInstances[req.query.key].sendReactionMessage(
        req.body.id,
        req.body.reacdata
    )
    return res.status(201).json({ error: false, data: data })
}

exports.Pix = async (req, res) => {
    const data = await WhatsAppInstances[req.query.key].sendMediaPix(
        req.body.id,
        req.body.base64code,
        req.body.caption
    )
    return res.status(201).json({ error: false, data: data })
}

exports.SetStatus = async (req, res) => {
    const presenceList = [
        'unavailable',
        'available',
        'composing',
        'recording',
        'paused',
    ]
    if (presenceList.indexOf(req.body.status) === -1) {
        return res.status(400).json({
            error: true,
            message:
                'status parameter must be one of ' + presenceList.join(', '),
        })
    }

    const data = await WhatsAppInstances[req.query.key]?.setStatus(
        req.body.status,
        req.body.id
    )
    return res.status(201).json({ error: false, data: data })
}
