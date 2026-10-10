// Preloaded into the pi-forum executable by cli.test.ts's partial topic creation test, as
// `node --import fail-message-append.mts bin/pi-forum ...`: every append of a message_posted record
// fails, so topic create writes its topic and then fails on its initial message.
import fs from 'node:fs/promises'

const appendFile = fs.appendFile
fs.appendFile = async (file, data, ...rest) => {
  if (String(data).includes('"message_posted"')) throw new Error('EIO: simulated failure')
  return appendFile(file, data, ...rest)
}
