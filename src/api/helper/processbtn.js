module.exports = function processButton(buttons) {
    const preparedButtons = []

    buttons.map((button) => {
        if (button.type == 'replyButton') {
            preparedButtons.push({
                index: button.index ?? '',
                quickReplyButton: {
                    displayText: button.title ?? ''
                }
            })
        }

        if (button.type == 'callButton') {
            preparedButtons.push({
                index: button.index ?? '',
                callButton: {
                    displayText: button.title ?? '',
                    phoneNumber: button.payload ?? ''
                }
            })
        }
        if (button.type == 'urlButton') {
            preparedButtons.push({
                index: button.index ?? '',
                urlButton: {
                    displayText: button.title ?? '',
                    url: button.payload ?? ''
                }
            })
        }
    })
    return preparedButtons
}
