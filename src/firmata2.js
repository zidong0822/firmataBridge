/// / Built-in Dependencies
const Emitter = require('events').EventEmitter

const AsyncLock = require('async-lock')

/**
 * constants
 */

const ANALOG_MAPPING_QUERY = 0x69
const ANALOG_MAPPING_RESPONSE = 0x6A
const ANALOG_MESSAGE = 0xE0
const CAPABILITY_QUERY = 0x6B
const CAPABILITY_RESPONSE = 0x6C
const DIGITAL_MESSAGE = 0x90
const END_SYSEX = 0xF7
const EXTENDED_ANALOG = 0x6F
const I2C_CONFIG = 0x78
const I2C_REPLY = 0x77
const I2C_REQUEST = 0x76
const PIN_MODE = 0xF4
const PIN_STATE_QUERY = 0x6D
const PIN_STATE_RESPONSE = 0x6E
const PING_READ = 0x75
const QUERY_FIRMWARE = 0x79
const REPORT_ANALOG = 0xC0
const REPORT_DIGITAL = 0xD0
const REPORT_VERSION = 0xF9
const SAMPLING_INTERVAL = 0x7A
const SERVO_CONFIG = 0x70
const SERIAL_MESSAGE = 0x60
const SERIAL_CONFIG = 0x10
const SERIAL_WRITE = 0x20
const SERIAL_READ = 0x30
const SERIAL_CLOSE = 0x50
const SERIAL_FLUSH = 0x60
const SERIAL_LISTEN = 0x70
const START_SYSEX = 0xF0
const STEPPER = 0x72
const STRING_DATA = 0x71
const SYSTEM_RESET = 0xFF
const MICRODUINO_OLED = 0x01
const MICRODUINO_COLOR_LED = 0x03
const MICRODUINO_BUZZER = 0x04
const MICRODUINO_MOTOR = 0x05
const MICRODUINO_IR = 0x07
const MICRODUINO_SERVO = 0x09
const MICRODUINO_MOTION = 0x0A
const MICRODUINO_NIXIETUBE = 0x0B
const MICRODUINO_CMD_DELAY = 40 // ms
const MICRODUINO_IBB = 0x0C

/**
 * MIDI_RESPONSE contains functions to be called when we receive a MIDI message from the arduino.
 * used as a switch object as seen here http://james.padolsey.com/javascript/how-to-avoid-switch-case-syndrome/
 * @private
 */

const MIDI_RESPONSE = {}

/**
 * Handles a REPORT_VERSION response and emits the reportversion event.
 * @private
 * @param {Board} board the current arduino board we are working with.
 */

MIDI_RESPONSE[REPORT_VERSION] = function (board) {
    console.log(board.firmware.name)
    board.version.major = board.currentBuffer[1]
    board.version.minor = board.currentBuffer[2]
    board.emit('reportversion')
}

/**
 * Handles a ANALOG_MESSAGE response and emits "analog-read" and "analog-read-"+n events where n is the pin number.
 * @private
 * @param {Board} board the current arduino board we are working with.
 */

MIDI_RESPONSE[ANALOG_MESSAGE] = function (board) {
    const pin = board.currentBuffer[0] & 0x0F
    const value = board.currentBuffer[1] | (board.currentBuffer[2] << 7)

    /* istanbul ignore else */
    if (board.pins[board.analogPins[pin]]) {
        board.pins[board.analogPins[pin]].value = value
    }

    board.emit(`analog-read-${pin}`, value)
    board.emit('analog-read', {
        pin: pin,
        value: value
    })
}

/**
 * Handles a DIGITAL_MESSAGE response and emits:
 * "digital-read"
 * "digital-read-"+n
 *
 * Where n is the pin number.
 *
 * @private
 * @param {Board} board the current arduino board we are working with.
 */

const KEY_PRESSED = 0
const KEY_RELEASED = 1
const KEY_PRESSING = 2

const KEY_IDLE = 99
MIDI_RESPONSE[DIGITAL_MESSAGE] = function (board) {
    const port = (board.currentBuffer[0] & 0x0F)
    const portValue = board.currentBuffer[1] | (board.currentBuffer[2] << 7)

    for (let i = 0; i < 8; i++) {
        const pinNumber = 8 * port + i
        const pin = board.pins[pinNumber]
        const bit = 1 << i

        if (pin && (pin.mode === board.MODES.INPUT || pin.mode === board.MODES.PULLUP)) {
            const currentValue = (portValue >> (i & 0x07)) & 0x01
            if (pin.value === 0 && currentValue === 1) {
                pin.event = KEY_RELEASED
            }
            if (pin.value === 1 && currentValue === 0) {
                pin.event = KEY_PRESSED
            }
            pin.value = currentValue

            if (pin.value) {
                board.ports[port] |= bit
            } else {
                board.ports[port] &= ~bit
            }

            board.emit(`digital-read-${pinNumber}`, pin.value)
            board.emit('digital-read', {
                pin: pinNumber,
                value: pin.value
            })
        }
    }
}

/**
 * SYSEX_RESPONSE contains functions to be called when we receive a SYSEX message from the arduino.
 * used as a switch object as seen here http://james.padolsey.com/javascript/how-to-avoid-switch-case-syndrome/
 * @private
 */

const SYSEX_RESPONSE = {}

/**
 * Handles a QUERY_FIRMWARE response and emits the "queryfirmware" event
 * @private
 * @param {Board} board the current arduino board we are working with.
 */

SYSEX_RESPONSE[QUERY_FIRMWARE] = function (board) {
    const length = board.currentBuffer.length - 2
    const buffer = Buffer.from(new Uint8Array(Math.round((length - 4) / 2)))
    let byte = 0
    let offset = 0
    for (let i = 4; i < length; i += 2) {
        byte = ((board.currentBuffer[i] & 0x7F) | ((board.currentBuffer[i + 1] & 0x7F) << 7)) & 0xFF
        buffer.writeUInt8(byte, offset++)
    }
    board.firmware = {
        name: buffer.toString(),
        version: {
            major: board.currentBuffer[2],
            minor: board.currentBuffer[3]
        }
    }

    board.emit('queryfirmware')
}

/**
 * Handles a CAPABILITY_RESPONSE response and emits the "capability-query" event
 * @private
 * @param {Board} board the current arduino board we are working with.
 */

SYSEX_RESPONSE[CAPABILITY_RESPONSE] = function (board) {
    let mode, resolution
    const modes = Object.keys(board.MODES).map(key => board.MODES[key])
    let capability = 0

    function supportedModes (capability) {
        return modes.reduce((accum, mode, index) => {
            if (capability & (1 << mode)) {
                accum.push(mode)
            }
            return accum
        }, [])
    }

    board.ports = new Array(16).fill(0)
    board.pins = []
    // Only create pins if none have been previously created on the instance.
    if (board.pins.length === 0) {
        for (let i = 2, n = 0; i < board.currentBuffer.length - 1; i++) {
            if (board.currentBuffer[i] === 127) {
                board.pins.push({
                    supportedModes: supportedModes(capability),
                    value: 0,
                    report: 1
                })
                capability = 0
                n = 0
                continue
            }
            if (n === 0) {
                mode = board.currentBuffer[i]
                resolution = (1 << board.currentBuffer[i + 1]) - 1
                capability |= (1 << mode)

                // ADC Resolution of Analog Inputs
                if (mode === board.MODES.ANALOG && board.RESOLUTION.ADC === null) {
                    board.RESOLUTION.ADC = resolution
                }

                // PWM Resolution of PWM Outputs
                if (mode === board.MODES.PWM && board.RESOLUTION.PWM === null) {
                    board.RESOLUTION.PWM = resolution
                }

                // DAC Resolution of DAC Outputs
                // if (mode === board.MODES.DAC && board.RESOLUTION.DAC === null) {
                //   board.RESOLUTION.DAC = resolution;
                // }
            }
            n ^= 1
        }
    }

    board.emit('capability-query')
}

/**
 * Handles a PIN_STATE response and emits the 'pin-state-'+n event where n is the pin number.
 *
 * Note about pin state: For output modes, the state is any value that has been
 * previously written to the pin. For input modes, the state is the status of
 * the pullup resistor.
 * @private
 * @param {Board} board the current arduino board we are working with.
 */

SYSEX_RESPONSE[PIN_STATE_RESPONSE] = function (board) {
    const pin = board.currentBuffer[2]
    board.pins[pin].mode = board.currentBuffer[3]
    board.pins[pin].state = board.currentBuffer[4]
    if (board.currentBuffer.length > 6) {
        board.pins[pin].state |= (board.currentBuffer[5] << 7)
    }
    if (board.currentBuffer.length > 7) {
        board.pins[pin].state |= (board.currentBuffer[6] << 14)
    }
    board.emit(`pin-state-${pin}`)
}

/**
 * Handles a ANALOG_MAPPING_RESPONSE response and emits the "analog-mapping-query" event.
 * @private
 * @param {Board} board the current arduino board we are working with.
 */

SYSEX_RESPONSE[ANALOG_MAPPING_RESPONSE] = function (board) {
    let pin = 0
    let currentValue
    board.analogPins = []
    for (let i = 2; i < board.currentBuffer.length - 1; i++) {
        currentValue = board.currentBuffer[i]
        board.pins[pin].analogChannel = currentValue
        if (currentValue !== 127) {
            board.analogPins.push(pin)
        }
        pin++
    }
    board.emit('analog-mapping-query')
}

let irData = { '0x1FE48B7': {},
    '0x1FE807F': {},
    '0x1FE40BF': {},
    '0x1FEC03F': {},
    '0x1FE20DF': {},
    '0x1FE609F': {},
    '0x1FEA05F': {},
    '0x1FED827': {},
    '0x1FEE01F': {},
    '0x1FE906F': {},
    '0x1FE10EF': {},
    '0x1FE50AF': {},
    '0x1FEF807': {},
    '0x1FE708F': {},
    '0x1FEB04F': {},
    '0x1FE30CF': {} }
let irTimer
let irCode = 0
SYSEX_RESPONSE[MICRODUINO_IR] = function (board) {
    const buffer = board.currentBuffer.slice(2, -1)
    if (buffer.length < 8) return

    let currentCode = 0
    for (let i = 3; i >= 0; i--) {
        currentCode <<= 8
        currentCode += buffer[i * 2] + (buffer[i * 2 + 1] << 7)
    }
    if (currentCode === 0) return

    if (currentCode === 0xFFFFFFFF || currentCode === -1) {
        clearTimeout(irTimer)
        currentCode = irCode
    } else {
        if (irCode > 0) {
            const k = `0x${irCode.toString(16).toUpperCase()}`
            const key = irData[k]
            key.value = 1
            key.event = KEY_RELEASED
        }

        const k = `0x${currentCode.toString(16).toUpperCase()}`
        const key = irData[k]
        key.value = 0
        key.event = KEY_PRESSED

        // for (const key of Object.keys(irData)) {
        //     const val = obj[key];
        //     if (parseInt(key) === code){

        //     }
        // }
    }

    irTimer = setTimeout(_ => {
        const k = `0x${irCode.toString(16).toUpperCase()}`
        const key = irData[k]
        key.value = 1
        key.event = KEY_RELEASED
    }, 300)

    irCode = currentCode
}

let motionData = []
SYSEX_RESPONSE[MICRODUINO_MOTION] = function (board) {
    const buffer = board.currentBuffer.slice(2, -1)
    if (buffer.length < 13) return
    const type = buffer.shift()

    const motion = {}
    let data = (buffer[0] + buffer[1] * 128) + ((buffer[2] + buffer[3] * 128) * 256)
    data = (data > 0x7FFF) ? (data - 0xFFFF) : data
    motion.x = data

    data = (buffer[4] + buffer[5] * 128) + ((buffer[6] + buffer[7] * 128) * 256)
    data = (data > 0x7FFF) ? (data - 0xFFFF) : data
    motion.y = data

    data = (buffer[8] + buffer[9] * 128) + ((buffer[10] + buffer[11] * 128) * 256)
    data = (data > 0x7FFF) ? (data - 0xFFFF) : data
    motion.z = data

    motionData[type] = motion

    board.emit(`motion-read-${type}`, motion)
}

SYSEX_RESPONSE[MICRODUINO_OLED] = function (board) {
    board.emit(`oled-response`)
}
SYSEX_RESPONSE[MICRODUINO_IBB] = function (board) {
    board.emit(`buggy-response`, board.currentBuffer)
}

/**
 * Handles a I2C_REPLY response and emits the "I2C-reply-"+n event where n is the slave address of the I2C device.
 * The event is passed the buffer of data sent from the I2C Device
 * @private
 * @param {Board} board the current arduino board we are working with.
 */
let i2cInputData = []
const ideaBoardKey = [
    { value: 0, event: KEY_IDLE, key: 'B' },
    { value: 0, event: KEY_IDLE, key: 'A' }
]
/*
const KEY_PRESSED = 0;
const KEY_RELEASED = 1;
const KEY_PRESSING = 2;
*/
let i2cOutputData = new Map()

function ideaBoardKeyParser (address, register, reply) {
    if (address === 0x56 && register === 0x09) {
        const data = `000000${(reply[0]).toString(2)}`.slice(-6)
        for (let j = 0; j < 2; j++) {
            // 0 => B
            // 1 => A
            const lastValue = ideaBoardKey[j].value
            const temp = +data[j]
            // 0 -> 1

            // 事件发生
            if (lastValue !== temp) {
                temp === 1 ? ideaBoardKey[j].value = 1 : ideaBoardKey[j].value = 0
                ideaBoardKey[j].event = KEY_PRESSED
                if (temp === 0) {
                    ideaBoardKey[j].event = KEY_RELEASED
                }
            }
            // console.log(j, ideaBoardKey[j].key, ideaBoardKey[j].value, ideaBoardKey[j].event);
        }
    }
}

SYSEX_RESPONSE[I2C_REPLY] = function (board) {
    const reply = []
    const address = (board.currentBuffer[2] & 0x7F) | ((board.currentBuffer[3] & 0x7F) << 7)
    const register = (board.currentBuffer[4] & 0x7F) | ((board.currentBuffer[5] & 0x7F) << 7)
    let temp
    for (let i = 6, length = board.currentBuffer.length - 1; i < length; i += 2) {
        temp = board.currentBuffer[i] | (board.currentBuffer[i + 1] << 7)
        reply.push(temp)
    }
    i2cInputData[`${address}_${register}`] = reply
    ideaBoardKeyParser(address, register, reply)
    board.emit(`I2C-reply-${address}-${register}`, reply)
}

/**
 * Handles a STRING_DATA response and logs the string to the console.
 * @private
 * @param {Board} board the current arduino board we are working with.
 */

SYSEX_RESPONSE[STRING_DATA] = function (board) {
    const string = Buffer.from(board.currentBuffer.slice(2, -1)).toString('utf8')
        .replace(/\0/g, '')
    board.emit('string', string)
}

/**
 * Response from pingRead
 */

SYSEX_RESPONSE[PING_READ] = function (board) {
    const pin = (board.currentBuffer[2] & 0x7F) | ((board.currentBuffer[3] & 0x7F) << 7)
    const durationBuffer = [
        (board.currentBuffer[4] & 0x7F) | ((board.currentBuffer[5] & 0x7F) << 7),
        (board.currentBuffer[6] & 0x7F) | ((board.currentBuffer[7] & 0x7F) << 7),
        (board.currentBuffer[8] & 0x7F) | ((board.currentBuffer[9] & 0x7F) << 7),
        (board.currentBuffer[10] & 0x7F) | ((board.currentBuffer[11] & 0x7F) << 7)
    ]
    const duration = ((durationBuffer[0] << 24) +
        (durationBuffer[1] << 16) +
        (durationBuffer[2] << 8) +
        (durationBuffer[3]))
    board.emit(`ping-read-${pin}`, duration)
}

/**
 * Handles the message from a stepper completing move
 * @param {Board} board
 */

SYSEX_RESPONSE[STEPPER] = function (board) {
    const deviceNum = board.currentBuffer[2]
    board.emit(`stepper-done-${deviceNum}`, true)
}

/**
 * @class The Board object represents an arduino board.
 * @augments EventEmitter
 * @param {String} port This is the serial port the arduino is connected to.
 * @param {function} function A function to be called when the arduino is ready to communicate.
 * @property MODES All the modes available for pins on this arduino board.
 * @property I2C_MODES All the I2C modes available.
 * @property SERIAL_MODES All the Serial modes available.
 * @property SERIAL_PORT_ID ID values to pass as the portId parameter when calling serialConfig.
 * @property HIGH A constant to set a pins value to HIGH when the pin is set to an output.
 * @property LOW A constant to set a pins value to LOW when the pin is set to an output.
 * @property pins An array of pin object literals.
 * @property analogPins An array of analog pins and their corresponding indexes in the pins array.
 * @property version An object indicating the major and minor version of the firmware currently running.
 * @property firmware An object indicateon the name, major and minor version of the firmware currently running.
 * @property currentBuffer An array holding the current bytes received from the arduino.
 * @property {SerialPort} sp The serial port object used to communicate with the arduino.
 */

function Board (port) {
    this.lock = new AsyncLock({ timeout: 2000, maxPending: 10 })
    Emitter.call(this)

    const options = {}
    const board = this
    const defaults = {
        reportVersionTimeout: 5000,
        samplingInterval: 19,
        serialport: {
            baudRate: 57600,
            bufferSize: 256
        }
    }

    const settings = Object.assign({}, defaults, {})

    this.isReady = false

    this.MODES = {
        INPUT: 0x00,
        OUTPUT: 0x01,
        ANALOG: 0x02,
        PWM: 0x03,
        SERVO: 0x04,
        SHIFT: 0x05,
        I2C: 0x06,
        ONEWIRE: 0x07,
        STEPPER: 0x08,
        SERIAL: 0x0A,
        PULLUP: 0x0B,
        IGNORE: 0x7F,
        PING_READ: 0x75,
        UNKOWN: 0x10
    }

    this.I2C_MODES = {
        WRITE: 0,
        READ: 1,
        CONTINUOUS_READ: 2,
        STOP_READING: 3
    }

    this.STEPPER = {
        TYPE: {
            DRIVER: 1,
            TWO_WIRE: 2,
            FOUR_WIRE: 4
        },
        RUNSTATE: {
            STOP: 0,
            ACCEL: 1,
            DECEL: 2,
            RUN: 3
        },
        DIRECTION: {
            CCW: 0,
            CW: 1
        }
    }

    this.SERIAL_MODES = {
        CONTINUOUS_READ: 0x00,
        STOP_READING: 0x01
    }

    // ids for hardware and software serial ports on the board
    this.SERIAL_PORT_IDs = {
        HW_SERIAL0: 0x00,
        HW_SERIAL1: 0x01,
        HW_SERIAL2: 0x02,
        HW_SERIAL3: 0x03,
        SW_SERIAL0: 0x08,
        SW_SERIAL1: 0x09,
        SW_SERIAL2: 0x10,
        SW_SERIAL3: 0x11,

        // Default can be used by depender libraries to key on a
        // single property name when negotiating ports.
        //
        // Firmata elects SW_SERIAL0: 0x08 as its DEFAULT
        DEFAULT: 0x08
    }

    // map to the pin resolution value in the capability query response
    this.SERIAL_PIN_TYPES = {
        RES_RX0: 0x00,
        RES_TX0: 0x01,
        RES_RX1: 0x02,
        RES_TX1: 0x03,
        RES_RX2: 0x04,
        RES_TX2: 0x05,
        RES_RX3: 0x06,
        RES_TX3: 0x07
    }

    this.RESOLUTION = {
        ADC: null,
        DAC: null,
        PWM: null
    }

    this.HIGH = 1
    this.LOW = 0

    this.ports = new Array(16).fill(0)
    this.pins = []
    this.analogPins = []

    this.version = {}
    this.firmware = {}
    this.currentBuffer = []
    this.versionReceived = false
    this.name = 'Firmata'
    this.settings = settings
    this.pending = 0

    this.transport = port

    this.transport.on('close', () => {
        this.emit('close')
    })

    this.transport.on('disconnect', () => {
        // disconnect maybe change hardware
        board.versionReceived = false
        board.isReady = false
        this.emit('disconnect')
    })

    this.transport.on('open', () => {
        // standardFirmata, disconnected then connect, speed up
        // microduino firmata, speed up
        this.reportVersionTimeoutId = setTimeout(() => {
            this.reportVersion(() => {})
            this.queryFirmware(() => {})
            console.log('query1')
            // standard firmata , waiting blinkVersion & reportVersion
            this.reportVersionTimeoutId = setTimeout(() => {
                this.reportVersion(() => {})
                this.queryFirmware(() => {})
                console.log('query2')
                this.emit('timeout')
            }, settings.reportVersionTimeout)
        }, 100)

        this.emit('open')
    })

    this.transport.on('error', error => {
        this.emit('error', error)
    })

    this.transport.on('data', data => {
        let byte, currByte, response, first, last, handler
        console.log(`Firmata received:${new Date().getTime()} :${new Uint8Array(data)}`)

        for (let i = 0; i < data.length; i++) {
            byte = data[i]
            // we dont want to push 0 as the first byte on our buffer
            if (this.currentBuffer.length === 0) {
                if (byte === 0) continue
                if (!this.versionReceived && byte !== REPORT_VERSION) continue
            }
            this.currentBuffer.push(byte)
            first = this.currentBuffer[0]
            last = this.currentBuffer[this.currentBuffer.length - 1]
            // [START_SYSEX, ... END_SYSEX]
            if (first === START_SYSEX && last === END_SYSEX) {
                handler = SYSEX_RESPONSE[this.currentBuffer[1]]
                // Ensure a valid SYSEX_RESPONSE handler exists
                // Only process these AFTER the REPORT_VERSION
                // message has been received and processed.
                if (handler && this.versionReceived) {
                    handler(this)
                }

                // It is possible for the board to have
                // existing activity from a previous run
                // that will leave any of the following
                // active:
                //
                //    - ANALOG_MESSAGE
                //    - SERIAL_READ
                //    - I2C_REQUEST, CONTINUOUS_READ
                //
                // This means that we will receive these
                // messages on transport "open", before any
                // handshake can occur. We MUST assert
                // that we will only process this buffer
                // AFTER the REPORT_VERSION message has
                // been received. Not doing so will result
                // in the appearance of the program "hanging".
                //
                // Since we cannot do anything with this data
                // until _after_ REPORT_VERSION, discard it.
                //
                this.currentBuffer.length = 0
            } else if (first === START_SYSEX && (this.currentBuffer.length > 0)) {
                // we have a new command after an incomplete sysex command
                currByte = data[i]
                if (currByte > 0x7F) {
                    this.currentBuffer.length = 0
                    this.currentBuffer.push(currByte)
                }
            } else {
                /* istanbul ignore else */
                if (first !== START_SYSEX) {
                    // Check if data gets out of sync: first byte in buffer
                    // must be a valid response if not START_SYSEX
                    // Identify response on first byte
                    response = first < START_SYSEX ? (first & START_SYSEX) : first

                    // Check if the first byte is possibly
                    // a valid MIDI_RESPONSE (handler)
                    /* istanbul ignore else */
                    if (response !== REPORT_VERSION &&
                        response !== ANALOG_MESSAGE &&
                        response !== DIGITAL_MESSAGE) {
                        // If not valid, then we received garbage and can discard
                        // whatever bytes have been been queued.
                        this.currentBuffer.length = 0
                    }
                }
            }

            // There are 3 bytes in the buffer and the first is not START_SYSEX:
            // Might have a MIDI Command
            if (this.currentBuffer.length === 3 && first !== START_SYSEX) {
                // response bytes under 0xF0 we have a multi byte operation
                response = first < START_SYSEX ? (first & START_SYSEX) : first
                /* istanbul ignore else */
                if (MIDI_RESPONSE[response]) {
                    // It's ok that this.versionReceived will be set to
                    // true every time a valid MIDI_RESPONSE is received.
                    // This condition is necessary to ensure that REPORT_VERSION
                    // is called first.
                    if (this.versionReceived || first === REPORT_VERSION) {
                        this.versionReceived = true
                        MIDI_RESPONSE[response](this)
                    }
                    this.currentBuffer.length = 0
                } else {
                    // A bad serial read must have happened.
                    // Reseting the buffer will allow recovery.
                    this.currentBuffer.length = 0
                }
            }
        }
    })

    // if we have not received the version within the alotted
    // time specified by the reportVersionTimeout (user or default),
    // then send an explicit request for it.
    // this.reportVersionTimeoutId = setTimeout(function() {
    //     /* istanbul ignore else */
    //     if (this.versionReceived === false) {
    //         this.reportVersion(function() {});
    //         this.queryFirmware(function() {});
    //     }
    // }.bind(this), settings.reportVersionTimeout);

    function ready () {
        board.isReady = true
        board.init()
        board.emit('ready')
    }

    // Await the reported version.
    this.on('reportversion', () => {
        clearTimeout(this.reportVersionTimeoutId)
        this.versionReceived = true

        // firmata reboot
        if (this.isReady) {
            this.init()
        }
    })

    this.on('queryfirmware', () => {
        // firmata reboot
        if (this.isReady) return

        // Only preemptively set the sampling interval if `samplingInterval`
        // property was _explicitly_ set as a constructor option.
        if (options.samplingInterval !== undefined) {
            this.setSamplingInterval(options.samplingInterval)
        }

        this.queryCapabilities(() => {
            this.queryAnalogMapping(ready)
        })
    })
}

Board.prototype = Object.create(Emitter.prototype, {
    constructor: {
        value: Board
    }
})

/**
 * return writeToTransport Due to the non-blocking behaviour of transport write
 *                   operations, dependent programs need a way to know
 *                   when all writes are complete. Every write increments
 *                   a `pending` value, when the write operation has
 *                   completed, the `pending` value is decremented.
 *
 * @param  {Board} board An active Board instance
 * @param  {Array} data  An array of 8 and 7 bit values that will be
 *                       wrapped in a Buffer and written to the transport.
 */

function getHexString (data) {
    const ret = []
    for (let i = 0; i < data.length; i++) {
        ret.push(data[i].toString(16))
    }
    return ret
}
function writeToTransport (board, data) {
    if (board.isClean) {
        board.isClean = false
    }

    return board.lock.acquire('comm', () => {
        console.log(`Firmata send:${getHexString(data)}`)
        return board.transport.write(Buffer.from(data))
    })
}

Board.prototype.getPinsForMode = function (mode) {
    return this.pins.reduce((pinlist, pin, index) => {
        if (pin.supportedModes.indexOf(mode) > -1) {
            pinlist.push(index)
        }
        return pinlist
    }, [])
}

/**
 * Asks the arduino to tell us its version.
 * @param {function} callback A function to be called when the arduino has reported its version.
 */

Board.prototype.reportVersion = function (callback) {
    // this.once("reportversion", callback);
    return writeToTransport(this, [REPORT_VERSION])
}

/**
 * Asks the arduino to tell us its firmware version.
 * @param {function} callback A function to be called when the arduino has reported its firmware version.
 */

Board.prototype.queryFirmware = function (callback) {
    this.once('queryfirmware', callback)
    return writeToTransport(this, [START_SYSEX, QUERY_FIRMWARE, END_SYSEX])
}

/**
 * Asks the arduino to read analog data. Turn on reporting for this pin.
 * @param {number} pin The pin to read analog data
 * @param {function} callback A function to call when we have the analag data.
 */
Board.prototype.analogRead = function (pin, callback) {
    // this.addListener("analog-read-" + pin, callback);
    if (this.analogPins && this.analogPins.length > pin) {
        const pinNumber = this.analogPins[pin]
        if (this.pins[pinNumber].mode !== this.MODES.ANALOG) {
            this.pinMode(pinNumber, this.MODES.ANALOG).then(() => this.reportAnalogPin(pin, 1))
            return new Promise((resolve, reject) => {
                this.once(`analog-read-${pin}`, resolve)
                setTimeout(_ => reject(new Error(`analog-read-${pin} timout`)), 1000)
            })
        }
        return Promise.resolve(this.pins[pinNumber].value)
    }
    return Promise.reject(new Error('Invalid analog read'))
}

/**
 * Write a PWM value Asks the arduino to write an analog message.
 * @param {number} pin The pin to write analog data to.
 * @param {nubmer} value The data to write to the pin between 0 and this.RESOLUTION.PWM.
 */

Board.prototype.pwmWrite = function (mode, pin, value) {
    const data = []

    if (pin > 15) {
        data[0] = START_SYSEX
        data[1] = EXTENDED_ANALOG
        data[2] = pin
        data[3] = value & 0x7F
        data[4] = (value >> 7) & 0x7F

        if (value > 0x00004000) {
            data[data.length] = (value >> 14) & 0x7F
        }

        if (value > 0x00200000) {
            data[data.length] = (value >> 21) & 0x7F
        }

        if (value > 0x10000000) {
            data[data.length] = (value >> 28) & 0x7F
        }

        data[data.length] = END_SYSEX
    } else {
        data.push(ANALOG_MESSAGE | pin, value & 0x7F, (value >> 7) & 0x7F)
    }

    if (this.pins && this.pins.length > pin) {
        let setmode = false
        let p = Promise.resolve()
        if (this.pins[pin].mode !== mode) {
            setmode = true
            p = p.then(() => this.pinMode(pin, mode))
        }
        if (this.pins[pin].value !== value || setmode) {
            p = p.then(() => writeToTransport(this, data)).then(() => {
                this.pins[pin].value = value
            })
        }
        return p
    }
    return Promise.reject(new Error('Invalid PWM write'))
}

Board.prototype.analogWrite = function (pin, value) {
    return this.pwmWrite(this.MODES.PWM, pin, value)
}

Board.prototype.servoWrite = function (pin, value) {
    return this.servoConfig(pin, 544, 2400)
        .then(_ => this.pwmWrite(this.MODES.SERVO, pin, value))
}
/**
 * Set a pin to SERVO mode with an explicit PWM range.
 *
 * @param {number} pin The pin the servo is connected to
 * @param {number} min A 14-bit signed int.
 * @param {number} max A 14-bit signed int.
 */

Board.prototype.servoConfig = function (pin, min, max) {
    // [0]  START_SYSEX  (0xF0)
    // [1]  SERVO_CONFIG (0x70)
    // [2]  pin number   (0-127)
    // [3]  minPulse LSB (0-6)
    // [4]  minPulse MSB (7-13)
    // [5]  maxPulse LSB (0-6)
    // [6]  maxPulse MSB (7-13)
    // [7]  END_SYSEX    (0xF7)

    if (this.pins[pin].mode === this.MODES.SERVO) {
        return Promise.resolve()
    }
    return writeToTransport(this, [
        START_SYSEX,
        SERVO_CONFIG,
        pin,
        min & 0x7F,
        (min >> 7) & 0x7F,
        max & 0x7F,
        (max >> 7) & 0x7F,
        END_SYSEX
    ])
}

/**
 * Asks the arduino to set the pin to a certain mode.
 * @param {number} pin The pin you want to change the mode of.
 * @param {number} mode The mode you want to set. Must be one of board.MODES
 */

Board.prototype.pinMode = function (pin, mode) {
    return writeToTransport(this, [PIN_MODE, pin, mode]).then(() => {
        this.pins[pin].mode = mode
    })
}

/**
 * Asks the arduino to write a value to a digital pin
 * @param {number} pin The pin you want to write a value to.
 * @param {number} value The value you want to write. Must be board.HIGH or board.LOW
 */

Board.prototype.digitalWrite = function (pin, value) {
    if (this && this.firmware && this.firmware.name && this.firmware.name.startsWith('sp')) {
        if (pin >= 14 && pin <= 21) {
            pin = pin + 10
        }
    }
    const port = pin >> 3
    const bit = 1 << (pin & 0x07)

    //    this.pins[pin].value = value;

    if (value) {
        this.ports[port] |= bit
    } else {
        this.ports[port] &= ~bit
    }

    if (this.pins && this.pins.length > pin) {
        let setmode = false
        let p = Promise.resolve()
        if (this.pins[pin].mode !== this.MODES.OUTPUT) {
            setmode = true
            p = p.then(() => this.pinMode(pin, this.MODES.OUTPUT))
        }

        if (this.pins[pin].value !== value || setmode) {
            p = p.then(() => writeToTransport(this, [
                DIGITAL_MESSAGE | port,
                this.ports[port] & 0x7F,
                (this.ports[port] >> 7) & 0x7F
            ])).then(() => {
                this.pins[pin].value = value
            })
        }

        return p
    }
    return Promise.reject(new Error('Invalid digital write'))
}

/**
 * Asks the arduino to read digital data. Turn on reporting for this pin's port.
 *
 * @param {number} pin The pin to read data from
 * @param {function} callback The function to call when data has been received
 */

Board.prototype.digitalRead = function (pin, callback) {
    if (this && this.firmware && this.firmware.name && this.firmware.name.startsWith('sp')) {
        if (pin >= 14 && pin <= 21) {
            pin = pin + 10
        }
    }
    if (this.pins && this.pins.length > pin) {
        if (this.pins[pin].mode !== this.MODES.INPUT) {
            return new Promise((resolve, reject) => {
                this.once(`digital-read-${pin}`, resolve)
                setTimeout(_ => reject(new Error(`digital-read-${pin} timeout`)), 1000)
                this.pinMode(pin, this.MODES.INPUT)
                // report digital
                if (this && this.firmware && this.firmware.name && this.firmware.name.startsWith('sp')) {
                    writeToTransport(this, [0xD0, 0x01, 0xD1, 0x01, 0xD2, 0x01, 0xD3, 0x01])
                } else {
                    writeToTransport(this, [0xD0, 0x01, 0xD1, 0x01, 0xD2, 0x01])
                }
            })
        }
        return Promise.resolve(this.pins[pin].value)
    }
    return Promise.reject(new Error('Invalid digital read'))
}

Board.prototype.motorBrake = function (motorid) {
    const msg = [START_SYSEX, MICRODUINO_MOTOR, 1, motorid, END_SYSEX]
    return writeToTransport(this, msg)
}

Board.prototype.motorControl = function (motorid, speed) {
    let direction = 1
    if (speed < 0) {
        speed = speed * -1
        direction = 0
    }
    if (speed > 255) {
        speed = 255
    }
    const msg = [START_SYSEX, MICRODUINO_MOTOR, motorid, direction, speed & 0x7F, (speed >> 7) & 0x7F, END_SYSEX]
    return writeToTransport(this, msg)
}

Board.prototype.motorCar = function (lSpeed, rSpeed) {
    let direction = 1
    if (lSpeed < 0) {
        lSpeed = lSpeed * -1
        direction = 0
    }
    if (lSpeed > 255) {
        lSpeed = 255
    }
    const msg = [START_SYSEX, MICRODUINO_MOTOR, 0, direction, lSpeed & 0x7F, (lSpeed >> 7) & 0x7F, END_SYSEX]

    direction = 1
    if (rSpeed < 0) {
        rSpeed = rSpeed * -1
        direction = 0
    }
    if (rSpeed > 255) {
        rSpeed = 255
    }
    msg.push(START_SYSEX, MICRODUINO_MOTOR, 1, direction, rSpeed & 0x7F, (rSpeed >> 7) & 0x7F, END_SYSEX)
    return writeToTransport(this, msg)
}

const transitionInterval = 30
Board.prototype.servoMove = function (pin, deg, startTime) {
    let time = new Date().getTime()
    const delay = transitionInterval - (time - startTime)
    let p = Promise.resolve()

    // console.log(`Servo move step: ${time}, deg:${deg}`);
    if (delay > 0) {
        p = p.then(_ => new Promise(resolve => setTimeout(resolve, delay)))
        time += delay
    }

    p = p.then(_ => this.servoWrite(pin, deg).then(_ => time))

    return p
}

Board.prototype.servoControl = function (pin, begin, end, duration) {
    if (duration < transitionInterval) {
        return this.servoWrite(pin, begin).then(_ => this.servoWrite(pin, end))
    }

    const count = Math.round(duration / transitionInterval)
    const time = new Date().getTime()
    let p = this.servoWrite(pin, begin).then(_ => time)
    const interval = (end - begin) / count

    // console.log(`Servo control steps:${count}, begin:${begin}, end:${end}, interval:${interval}`);
    let deg = begin
    for (let i = 0; i < count - 1; i++) {
        deg += interval
        const degInt = Math.round(deg)
        p = p.then(startTime => this.servoMove(pin, degInt, startTime))
    }
    if (Math.round(deg) < end) {
        p = p.then(startTime => this.servoMove(pin, end, startTime))
    }

    return p.then(_ => Promise.resolve())
}

function hexToRgb (hex) {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex)
    return result ? {
        r: parseInt(result[1], 16),
        g: parseInt(result[2], 16),
        b: parseInt(result[3], 16)
    } : null
}

const maxLedCount = 16
let colorLEDFlashStop
Board.prototype.colorLEDControl = function (pin, number, begin, end, duration) {
    const bColor = hexToRgb(begin)
    const eColor = hexToRgb(end)
    colorLEDFlashStop = false
    if (this && this.firmware && this.firmware.name && this.firmware.name.startsWith('sp')) {
        if (pin >= 14 && pin <= 21) {
            pin = pin + 10
        }
    }
    console.log('console.log(pin): ', pin)
    if (duration < transitionInterval) {
        return this.colorLEDRGB(pin, number, bColor.r, bColor.g, bColor.b).then(_ => this.colorLEDRGB(pin, number, eColor.r, eColor.g, eColor.b))
    }

    const count = Math.round(duration / transitionInterval)
    const time = new Date().getTime()
    let p = this.colorLEDRGB(pin, number, bColor.r, bColor.g, bColor.b).then(_ => time)

    const interval = {}
    interval.r = (eColor.r - bColor.r) / count
    interval.g = (eColor.g - bColor.g) / count
    interval.b = (eColor.b - bColor.b) / count

    const color = bColor
    for (let i = 0; i < count - 1; i++) {
        color.r += interval.r
        color.g += interval.g
        color.b += interval.b
        const r = Math.round(color.r)
        const g = Math.round(color.g)
        const b = Math.round(color.b)
        p = p.then(startTime => this.colorLEDDelay(pin, number, r, g, b, startTime))
    }

    p = p.then(startTime => this.colorLEDDelay(pin, number, eColor.r, eColor.g, eColor.b, startTime))

    return p.then(_ => Promise.resolve())
}

Board.prototype.colorLEDDelay = function (pin, number, red, green, blue, startTime) {
    let time = new Date().getTime()
    const delay = transitionInterval - (time - startTime)
    let p = Promise.resolve()

    if (colorLEDFlashStop) {
        return Promise.reject(new Error('colorLED flash stoped'))
    }

    if (delay > 0) {
        p = p.then(_ => new Promise(resolve => setTimeout(resolve, delay)))
        time += delay
    }

    p = p.then(_ => this.colorLEDRGB(pin, number, red, green, blue).then(_ => time))

    return p
}

Board.prototype.colorLEDColor = function (pin, number, color) {
    const rgbColor = hexToRgb(color)
    if (this && this.firmware && this.firmware.name && this.firmware.name.startsWith('sp')) {
        if (pin >= 14 && pin <= 21) {
            pin = pin + 10
        }
    }
    console.log('console.log(pin): ', pin)
    /* if(colorLEDBuffer[number] == color){
        return Promise.resolve();
    }else{
        colorLEDBuffer[number] = color;
        return this.colorLEDRGB(pin, number, rgbColor.r, rgbColor.g, rgbColor.b);
    } */
    return this.colorLEDRGB(pin, number, rgbColor.r, rgbColor.g, rgbColor.b)
}

Board.prototype.colorLEDRGB = function (pin, number, red, green, blue) {
    let p = this.sensorPrepare(MICRODUINO_COLOR_LED, [maxLedCount, pin])

    const msg = [START_SYSEX, MICRODUINO_COLOR_LED, number & 0x7F, red & 0x7F, (red >> 7) & 0x7F, green & 0x7F, (green >> 7) & 0x7F, blue & 0x7F, (blue >> 7) & 0x7F, END_SYSEX]
    p = p.then(_ => writeToTransport(this, msg))
    return p
}
Board.prototype.colorFromRGB = function (red, green, blue) {
    const hexStr = `#${[red, green, blue].map(x => {
        const hex = x.toString(16)
        return hex.length === 1 ? `0${hex}` : hex
    }).join('')}`
    return hexStr
}

const tone_list = [0, 262, 294, 330, 349, 392, 440, 494, 523, 587, 659, 698, 784, 880, 988, 1046, 1175, 1318, 1397, 1568, 1760, 1967]
let music = []; let rhythm = []
music[1] = [12, 10, 12, 10, 12, 10, 9, 10, 12, 12, 12, 10, 13, 12, 10, 12, 10, 9, 8, 9, 10, 12, 10, 9, 8, 9, 10]
rhythm[1] = [1, 0.5, 1, 0.5, 0.5, 0.5, 0.5, 0.5, 2, 0.5, 1, 0.5, 1, 1, 0.5, 0.5, 0.5, 0.5, 1, 1, 1, 1, 0.5, 0.5, 0.5, 0.5, 2]
music[2] = [8, 9, 10, 8, 8, 9, 10, 8, 10, 11, 12, 10, 11, 12]
rhythm[2] = [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 1, 1, 2]
music[3] = [5, 8, 8, 10, 13, 10, 12, 12, 13, 12, 10, 11, 10, 9, 6, 9, 9, 11, 14, 14, 13, 12, 11, 11, 10, 6, 7, 8, 9]
rhythm[3] = [0.5, 0.25, 0.5, 0.25, 0.5, 0.25, 1, 0.5, 0.25, 0.5, 0.25, 0.5, 0.25, 1, 0.5, 0.25, 0.5, 0.25, 0.5, 0.25, 0.5, 0.25, 1, 0.5, 0.25, 0.5, 1, 0.5, 3].map(v => 2 * v)
music[4] = [5, 5, 6, 5, 8, 7, 5, 5, 6, 5, 9, 8, 5, 5, 12, 10, 8, 7, 6, 11, 11, 10, 8, 9, 8]
rhythm[4] = [0.5, 0.5, 1, 1, 1, 2, 0.5, 0.5, 1, 1, 1, 2, 0.5, 0.5, 1, 1, 1, 1, 1, 0.5, 0.5, 1, 1, 1, 3]
music[5] = [12, 13, 12, 13, 12, 13, 12, 12, 15, 14, 13, 12, 13, 12, 12, 12, 10, 10, 12, 12, 10, 9, 11, 10, 9, 8, 9, 8]
rhythm[5] = [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 1, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 1, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 1, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 1]
music[6] = [8, 8, 10, 8, 8, 10, 0, 13, 13, 13, 12, 13, 12, 8, 10, 0, 15, 13, 13, 12, 13, 12, 8, 9, 0, 14, 14, 12, 10, 12]
rhythm[6] = [1, 1, 2, 0.5, 1, 1, 1, 1, 1, 0.5, 0.5, 1, 0.5, 1, 1, 1, 0.5, 0.5, 0.5, 0.5, 2, 0.5, 1, 1, 1, 1, 0.5, 0.5, 1, 4]
music[7] = [6, 8, 9, 10, 12, 10, 8, 9, 6, 0, 8, 9, 10, 12, 12, 13, 9, 10, 0, 10, 12, 13, 12, 13, 15, 14, 13, 12, 13, 10, 8, 9, 10, 12, 8, 6, 8, 9, 10, 13, 12]
rhythm[7] = [0.5, 0.5, 0.5, 1, 0.5, 0.5, 0.5, 1, 2, 0.5, 0.5, 0.5, 0.5, 1, 0.5, 1, 1, 2, 1, 0.5, 0.5, 2, 1, 0.5, 0.5, 0.25, 0.25, 0.5, 0.5, 1, 0.5, 0.5, 1, 0.5, 1, 1, 0.5, 0.5, 0.5, 0.5, 3]
music[8] = [10, 8, 9, 6, 10, 9, 8, 9, 6, 10, 8, 9, 9, 12, 10, 7, 8, 8, 7, 6, 7, 8, 9, 5, 13, 12, 10, 10, 9, 8, 9, 10, 9, 10, 9, 12, 12, 12, 12, 12, 12]
rhythm[8] = [1, 1, 1, 1, 0.5, 0.5, 0.5, 0.5, 2, 1, 1, 1, 1, 0.5, 0.5, 1, 1, 0.5, 0.5, 1, 0.5, 0.5, 1, 1, 0.5, 0.5, 1, 1, 0.5, 1, 0.5, 0.5, 0.5, 0.5, 0.5, 1, 0.5, 0.5, 0.5, 0.5, 1]
music[9] = [10, 12, 15, 13, 12, 10, 12, 13, 15, 12, 15, 17, 16, 15, 16, 15, 13, 15, 12]
rhythm[9] = [0.5, 0.5, 0.5, 0.5, 2, 0.5, 0.5, 0.5, 0.5, 2, 1, 0.5, 1, 1, 0.5, 0.5, 0.5, 0.5, 2]
music[10] = [10, 10, 10, 8, 5, 5, 0, 10, 10, 10, 8, 10, 0, 12, 12, 10, 8, 5, 5, 5, 6, 7, 8, 10, 9]
rhythm[10] = [0.5, 0.5, 0.5, 0.5, 1, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 1, 1, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 1, 0.5, 0.5, 0.5, 0.5, 1]
const beatDuration = 300
let buzzerSongStop
Board.prototype.buzzerOff = function (pin) {
    buzzerSongStop = true
    if (this && this.firmware && this.firmware.name && this.firmware.name.startsWith('sp')) {
        if (pin >= 14 && pin <= 21) {
            pin = pin + 10
        }
    }
    const msg = [START_SYSEX, MICRODUINO_BUZZER, pin, END_SYSEX]
    return writeToTransport(this, msg)
}

Board.prototype.buzzerNote = function (pin, frequency, beats) {
    return this.buzzerControl(pin, frequency, beats * 1000)
}

Board.prototype.buzzerControl = function (pin, freq, duration) {
    if (this && this.firmware && this.firmware.name && this.firmware.name.startsWith('sp')) {
        if (pin >= 14 && pin <= 21) {
            pin = pin + 10
        }
    }
    const msg = [START_SYSEX, MICRODUINO_BUZZER, pin, freq & 0x7F, (freq >> 7) & 0x7F, duration & 0x7F, (duration >> 7) & 0x7F, END_SYSEX]
    return writeToTransport(this, msg)
}

Board.prototype.buzzerSong = function (pin, songNumber) {
    buzzerSongStop = false
    const song = music[songNumber]
    const beats = rhythm[songNumber]
    let p = Promise.resolve()
    for (let i = 0; i < music[songNumber].length; i++) {
        const note = tone_list[song[i]]
        const duration = beatDuration * beats[i]
        if (note === 0) {
            p = p.then(_ => this.buzzerOff(pin).then(_ => new Promise(resolve => setTimeout(resolve, duration))))
        } else {
            if (this && this.firmware && this.firmware.name && this.firmware.name.startsWith('sp')) {
                if (pin >= 14 && pin <= 21) {
                    pin = pin + 10
                }
            }
            p = p.then(_ => this.buzzerSongPlay(pin, note, duration))
        }
    }

    return p
}

Board.prototype.buzzerSongPlay = function (pin, freq, duration) {
    if (buzzerSongStop) {
        return Promise.reject(new Error('Buzzer song stoped'))
    }

    return this.buzzerControl(pin, freq, duration).then(_ => new Promise(resolve => setTimeout(resolve, duration)))
}

Board.prototype.OLEDControl = function (type, x, y, value) {
    let msg = [START_SYSEX, MICRODUINO_OLED, type]
    if (type < 9) {
        msg.push(x, y)
    }
    if (type === 0) {
        for (let i = 0; i < value.length; i++) {
            msg.push(value.charCodeAt(i))
        }
    }
    if (type === 1 || type === 2) {
        msg = msg.concat(value)
    }
    if (type === 3) {
        msg.push(value)
    }
    msg.push(END_SYSEX)

    const p = new Promise((resolve, reject) => {
        this.once(`oled-response`, resolve)
        setTimeout(_ => reject(new Error('oled response timeout')), 500)
    })
    return writeToTransport(this, msg).then(_ => p)
}

let I2CActived = false
Board.prototype.i2cConfig = function (options) {
    if (I2CActived) return Promise.resolve()
    const delay = 50
    const msg = [
        START_SYSEX,
        I2C_CONFIG,
        delay & 0xFF, (delay >> 8) & 0xFF,
        END_SYSEX
    ]

    return writeToTransport(this, msg).then(_ => {
        I2CActived = true
    })
}

Board.prototype.i2cRequestRead = function (addr, reg, mode, bytesToRead) {
    const data = i2cInputData[`${addr}_${reg}`]
    if (data) {
        return Promise.resolve(data)
    }
    const p = this.i2cConfig()
    return p.then(() => new Promise((resolve, reject) => {
        this.once(`I2C-reply-${addr}-${reg}`, resolve)
        setTimeout(_ => reject(new Error(`I2C-reply-${addr}-${reg} timeout`)), 1000)
        const msg = [START_SYSEX, I2C_REQUEST, addr & 0x7F, mode << 3, reg & 0x7F, (reg >> 7) & 0x7F, bytesToRead & 0x7F, (bytesToRead >> 7) & 0x7F, END_SYSEX]
        writeToTransport(this, msg)
    }))
}

/**
 * Asks the arduino to send an I2C request to a device
 * @param {number} slaveAddress The address of the I2C device
 * @param {Array} bytes The bytes to send to the device
 */

Board.prototype.i2cRequestWrite = function (slaveAddress, bytes) {
    const msg = [START_SYSEX, I2C_REQUEST, slaveAddress, this.I2C_MODES.WRITE << 3]
    for (let i = 0, length = bytes.length; i < length; i++) {
        msg.push(bytes[i] & 0x7F, (bytes[i] >> 7) & 0x7F)
    }
    msg.push(END_SYSEX)

    const p = this.i2cConfig()
    return p.then(() => writeToTransport(this, msg))
}

Board.prototype.i2cRequestWriteBuffer = function (address, register, bytes) {
    const key = `${address}_${register}`
    if (Object.prototype.toString.call(bytes) !== '[object Array]') {
        bytes = [bytes]
    }
    if (i2cOutputData.has(key) && i2cOutputData.get(key).join() === bytes.join()) {
        return Promise.resolve()
    }
    const msg = [START_SYSEX, I2C_REQUEST, address, this.I2C_MODES.WRITE << 3, register & 0x7F, register >> 7]
    i2cOutputData.set(key, bytes)
    for (let i = 0, length = bytes.length; i < length; i++) {
        msg.push(bytes[i] & 0x7F, (bytes[i] >> 7) & 0x7F)
    }
    msg.push(END_SYSEX)

    const p = this.i2cConfig()
    return p.then(() => writeToTransport(this, msg))
}

Board.prototype.gestureDistance = function () {
    const address = 0x39

    let p
    if (sensorPrepareMap.has('GestureDistance')) {
        p = Promise.resolve()
    } else {
        p = this.i2cRequestWrite(address, [0x8F, 5])
            .then(_ => this.i2cRequestWrite(address, [0x80, 5]))
    }

    p = p.then(_ => {
        sensorPrepareMap.set('GestureDistance')
        return this.i2cRequestRead(address, 0x9C, 2, 1)
    })
    return p
}

/**
 * Asks the arduino to send an ideaBox request to a device
 * @param {number} pin The address of the ideaBox device
 * @param {Array} bytes The bytes to send to the device
 */

let sensorPrepareMap = new Map()
Board.prototype.sensorPrepare = function (sensor, bytes) {
    const msg = [START_SYSEX, sensor]
    for (let i = 0, length = bytes.length; i < length; i++) {
        msg.push(bytes[i] & 0x7F)
    }
    msg.push(END_SYSEX)

    if (sensorPrepareMap.has(msg.join())) {
        return Promise.resolve()
    }
    return writeToTransport(this, msg).then(() => {
        sensorPrepareMap.set(msg.join(), true)
    })
}

Board.prototype.ideaBoxServo = function (angle) {
    const msg = [START_SYSEX, MICRODUINO_SERVO, angle & 0x7F, (angle >> 7) & 0x7F, END_SYSEX]
    return writeToTransport(this, msg).then(_ => new Promise(resolve => setTimeout(resolve, MICRODUINO_CMD_DELAY)))
}

let ideaboardLed = 0
Board.prototype.ideaBoardLed = function (led, value) {
    const addr = 0x56
    const reg = 0x24
    if (value === 1) {
        ideaboardLed |= (1 << led)
    } else {
        ideaboardLed &= (~(1 << led))
    }

    return this.i2cRequestWriteBuffer(addr, reg, ideaboardLed)
}

Board.prototype.setNixieTube = function (pin, index, value, hasPoint) {
    if (this && this.firmware && this.firmware.name && this.firmware.name.startsWith('sp')) {
        if (pin >= 14 && pin <= 21) {
            pin = pin + 10
        }
    }
    if (hasPoint) hasPoint = 1
    else hasPoint = 0
    const msg = [START_SYSEX, MICRODUINO_NIXIETUBE, hasPoint, index, value & 0x7F, END_SYSEX]
    return this.sensorPrepare(MICRODUINO_NIXIETUBE, [2, pin, 0])
        .then(_ => writeToTransport(this, msg))
        .then(_ => new Promise(resolve => setTimeout(resolve, MICRODUINO_CMD_DELAY)))
}

Board.prototype.sendNixieTube = function (pin, index, value, first) {
    if (this && this.firmware && this.firmware.name && this.firmware.name.startsWith('sp')) {
        if (pin >= 14 && pin <= 21) {
            pin = pin + 10
        }
    }
    if (first === true) {
        first = 0x01
    } else if (first === false) {
        first = 0x00
    }

    const msg = [START_SYSEX, MICRODUINO_NIXIETUBE, first, index, value & 0x7F, END_SYSEX]
    return this.sensorPrepare(MICRODUINO_NIXIETUBE, [2, pin, 0])
        .then(_ => writeToTransport(this, msg))
        .then(_ => new Promise(resolve => setTimeout(resolve, MICRODUINO_CMD_DELAY)))
}

Board.prototype.getMotion = function (pin, type, axes) {
    let p = this.sensorPrepare(MICRODUINO_MOTION, [pin, type])

    if (motionData[type]) {
        p = p.then(() => motionData[type])
    } else {
        p = p.then(() => new Promise((resolve, reject) => {
            this.once(`motion-read-${type}`, resolve)
            setTimeout(() => reject(new Error('Get motion timeout')), 5000)
        }))
    }
    return p.then(data => {
        if (axes === 'X') return data.x
        if (axes === 'Y') return data.y
        return data.z
    })
}

Board.prototype.irKey = function (pin, keyIn, event) {
    const key = `0x${keyIn.toString(16).toUpperCase()}`
    if (this && this.firmware && this.firmware.name && this.firmware.name.startsWith('sp')) {
        if (pin >= 14 && pin <= 21) {
            pin = pin + 10
        }
    }
    this.sensorPrepare(MICRODUINO_IR, [pin])
    let result = false

    if ((event === KEY_PRESSED && irData[key].event === KEY_PRESSED) ||
        (event === KEY_RELEASED && irData[key].event === KEY_RELEASED)) {
        result = true
        irData[key].event = KEY_IDLE
    }

    if (event === KEY_PRESSING) {
        result = (irData[key].value === 0)
    }

    return Promise.resolve(result)
}

// event : [['released', '1'], ['pressed', '0'], ['pressing', '2']];
Board.prototype.ideaBoardKey = function (addr, reg, mode, bytesToRead, button, event) {
    let key = 0 // 'B'
    if (button === 'A') {
        key = 1
    }
    this.i2cRequestRead(addr, reg, mode, bytesToRead)
    let result = false
    if ((event === KEY_PRESSED && ideaBoardKey[key].event === KEY_PRESSED) ||
        (event === KEY_RELEASED && ideaBoardKey[key].event === KEY_RELEASED)) {
        result = true
        ideaBoardKey[key].event = KEY_IDLE
    }

    if (event === KEY_PRESSING) {
        result = (ideaBoardKey[key].value === 1)
    }

    return Promise.resolve(result)
}

Board.prototype.touchKey = function (pin, event) {
    if (this && this.firmware && this.firmware.name && this.firmware.name.startsWith('sp')) {
        if (pin >= 14 && pin <= 21) {
            pin = pin + 10
        }
    }
    return this.digitalRead(pin).then(value => {
        let result = false
        if ((event === KEY_PRESSED && this.pins[pin].event === KEY_PRESSED) ||
            (event === KEY_RELEASED && this.pins[pin].event === KEY_RELEASED)) {
            result = true
            this.pins[pin].event = KEY_IDLE
        }
        if (event === KEY_PRESSING) {
            result = (value === 0)
        }
        return result
    })
}

let joystick = []

const JOY_UP = 1
const JOY_DOWN = 2
const JOY_LEFT = 3
const JOY_RIGHT = 4
const JOY_CENTER = 0
const JOY_RELEASE = 5

Board.prototype.joystickKey = function (pin, key, event) {
    if (!joystick[pin]) {
        joystick[pin] = []
        for (let i = 0; i < 5; i++) {
            joystick[pin][i] = {}
        }
    }
    return this.analogRead(pin).then(val => {
        let joyStatus = JOY_RELEASE
        if (val < 50) {
            joyStatus = JOY_CENTER
        } else if (val > 274 && val < 374) {
            joyStatus = JOY_DOWN
        } else if (val > 459 && val < 559) {
            joyStatus = JOY_LEFT
        } else if (val > 651 && val < 751) {
            joyStatus = JOY_UP
        } else if (val > 806 && val < 906) {
            joyStatus = JOY_RIGHT
        }

        let result = false
        for (let i = 0; i < 5; i++) {
            if (i === joyStatus) {
                if (joystick[pin][i].value === 1) {
                    joystick[pin][i].event = KEY_PRESSED
                }
                joystick[pin][i].value = 0
            } else {
                if (joystick[pin][i].value === 0) {
                    joystick[pin][i].event = KEY_RELEASED
                }
                joystick[pin][i].value = 1
            }

            if (i === key) {
                if ((event === KEY_PRESSED && joystick[pin][i].event === KEY_PRESSED) ||
                    (event === KEY_RELEASED && joystick[pin][i].event === KEY_RELEASED)) {
                    result = true
                    joystick[pin][i].event = KEY_IDLE
                }
                if (event === KEY_PRESSING) {
                    result = (joystick[pin][i].value === 0)
                }
            }
        }

        return result
    })
}

let dotMaxtrixBuffer = null
function setMatrixPoint (x, y, target, cmd) {
    dotMaxtrixBuffer[y * 8 + x] = target
    let coordinate = 0b11000000
    coordinate |= x << 3
    coordinate |= y
    cmd.push(coordinate)

    const color = hexToRgb(target)
    const c = ((color.b >> 6) << 4) | ((color.g >> 6) << 2) | (color.r >> 6)
    cmd.push(c)
}

Board.prototype.dotMatrixPoint = function (addr, x, y, color) {
    const cmd = []
    if (!dotMaxtrixBuffer) {
        dotMaxtrixBuffer = new Array(64).fill('#000000')
        cmd.push(0x60, 0x00) // clear screen
    }

    setMatrixPoint(x, y, color, cmd)

    return this.i2cRequestWrite(addr, cmd)
}

Board.prototype.dotMatrixColor = function (addr, colors) {
    const colorList = colors.split('#')
    colorList.shift()
    let cmd = []
    if (!dotMaxtrixBuffer) {
        dotMaxtrixBuffer = new Array(64).fill('#000000')
        cmd.push(0x60, 0x00) // clear screen
    }
    let darkScreen = true

    for (let y = 0; y < 8; y++) {
        for (let x = 0; x < 8; x++) {
            const target = `#${colorList[y * 8 + x]}`
            if (target !== '#000000') darkScreen = false
            const buffer = dotMaxtrixBuffer[y * 8 + x]
            /*
             * Clear screen : 0x60
             * 2bit
             * Coordinate : 11xxxyyy
             * Data:      : 0nBBGGRR
             *
             * 5bit
             * Coordinate : 10xxxyyy
             * Data       : 0ccCCCCC
             * cc: R:0, G:1, B:2
             * CCCCC:5bit color
             */

            if (buffer !== target) {
                setMatrixPoint(x, y, target, cmd)
            }
        }
    }

    if (darkScreen) {
        cmd = [0x60]
    }

    let p = Promise.resolve()
    let sent = 0
    console.log(`CMD:${cmd}`)
    while (cmd.length > sent) {
        const count = (cmd.length - sent > 30) ? 30 : (cmd.length - sent)
        const data = cmd.slice(sent, sent + count)
        sent += count
        p = p.then(_ => this.i2cRequestWrite(addr, data))
    }
    return p
}

Board.prototype.bot_car_forward = function (direction, speed) {
    const msg = [START_SYSEX, 0x0C, 1, 3, direction, direction, speed & 0x7F, (speed >> 7) & 0x7F, speed & 0x7F, (speed >> 7) & 0x7F, END_SYSEX]
    return writeToTransport(this, msg)
}

Board.prototype.bot_car_turn = function (direction, speed) {
    let msg = []
    if(direction === '0') {
        msg = [START_SYSEX, 0x0C, 1, 3, 1, 1, 0 & 0x7F, (0 >> 7) & 0x7F, speed & 0x7F, (speed >> 7) & 0x7F, END_SYSEX]
    }else{
        msg = [START_SYSEX, 0x0C, 1, 3, 1, 1, speed & 0x7F, (speed >> 7) & 0x7F, 0 & 0x7F, (0 >> 7) & 0x7F, END_SYSEX]
    }
    writeToTransport(this, msg)
}

Board.prototype.bot_motor_control = function (type, speed) {
    let msg = []
    let forward = 1
    if(speed < 0) {
        speed = speed * -1
        forward = 0
    }
    switch (type) {
        case '1':
            msg = [START_SYSEX, 0x0C, 1, 1, forward, speed & 0x7F, (speed >> 7) & 0x7F, END_SYSEX]
            break
        case '2':
            msg = [START_SYSEX, 0x0C, 1, 2, forward, speed & 0x7F, (speed >> 7) & 0x7F, END_SYSEX]
            break
        case '3':
            msg = [START_SYSEX, 0x0C, 1, 3, forward, forward, speed & 0x7F, (speed >> 7) & 0x7F, speed & 0x7F, (speed >> 7) & 0x7F, END_SYSEX]
            break
        default:break
    }
    return writeToTransport(this, msg)
}

Board.prototype.bot_motor_stop = function (type) {
    let msg = []
    switch (type) {
        case '1':
            msg = [START_SYSEX, 0x0C, 1, 1, 1, 0 & 0x7F, (0 >> 7) & 0x7F, END_SYSEX]
            break
        case '2':
            msg = [START_SYSEX, 0x0C, 1, 2, 1, 0 & 0x7F, (0 >> 7) & 0x7F, END_SYSEX]
            break
        case '3':
            msg = [START_SYSEX, 0x0C, 1, 3, 1, 1, 0 & 0x7F, (0 >> 7) & 0x7F, 0 & 0x7F, (0 >> 7) & 0x7F, END_SYSEX]
            break
        default:break
    }
    return writeToTransport(this, msg)
}

Board.prototype.botLEDColor = function (pin, color) {
    const rgbColor = hexToRgb(color)
    const red = rgbColor.r
    const green = rgbColor.g
    const blue = rgbColor.b
    const msg = [START_SYSEX, 0x0C, 0, pin, red & 0x7F, (red >> 7) & 0x7F, green & 0x7F, (green >> 7) & 0x7F, blue & 0x7F, (blue >> 7) & 0x7F, END_SYSEX]
    return writeToTransport(this, msg)
}
Board.prototype.bot_find_line = function (color, speed) {
    const msg = [START_SYSEX, 0x0C, 5, 1, color, speed & 0x7F, (speed >> 7) & 0x7F, END_SYSEX]
    return writeToTransport(this, msg)
}
Board.prototype.bot_find_stop = function () {
    const msg = [START_SYSEX, 0x0C, 5, 0, 0, 0, 0, END_SYSEX]
    return writeToTransport(this, msg)
}
Board.prototype.bot_judge_color = function (type, botColor) {
    const msg = [START_SYSEX, 0x0C, 4, type, END_SYSEX]
    const p = new Promise((resolve, reject) => {
        this.once(`buggy-response`, (data) => {
            let responseData = Buffer.from(data)
            resolve(responseData)
        })
        setTimeout(_ => reject(new Error('buggy response timeout')), 500)
    }).then((data) => {
        return Promise.resolve(data[4] === parseInt(botColor))
    })
    writeToTransport(this, msg)
    return p
}

Board.prototype.bot_buzzer_pitch = function (pitch) {
    const msg = [START_SYSEX, 0x0C, 2, 0, pitch & 0x7F, (pitch >> 7) & 0x7F, END_SYSEX]
    return writeToTransport(this, msg)
}

Board.prototype.bot_buzzer_song = function (songNumber) {
    buzzerSongStop = false
    const song = music[songNumber]
    const beats = rhythm[songNumber]
    let p = Promise.resolve()
    setTimeout(() => {
        for (let i = 0; i < music[songNumber].length; i++) {
            const note = tone_list[song[i]]
            const duration = beatDuration * beats[i]
            if (note === 0) {
                p = p.then(_ => this.bot_buzzer_stop().then(_ => new Promise(resolve => setTimeout(resolve, duration))))
            } else {
                p = p.then(_ => this.bot_buzzer_play(note, duration))
            }
        }
        return p
    }, 100)
}
Board.prototype.bot_buzzer_play = function (note, duration) {
    const msg = [START_SYSEX, 0x0C, 2, 1, note & 0x7F, (note >> 7) & 0x7F, duration & 0x7F, (duration >> 7) & 0x7F, END_SYSEX]
    return writeToTransport(this, msg).then(_ => new Promise(resolve => setTimeout(resolve, duration)))
}

Board.prototype.bot_buzzer_stop = function () {
    const msg = [START_SYSEX, 0x0C, 2, 0, 0 & 0x7F, (0 >> 7) & 0x7F, END_SYSEX]
    return writeToTransport(this, msg)
}

Board.prototype.bot_get_gray = function (type, gray) {
    const msg = [START_SYSEX, 0x0C, 3, type, gray, END_SYSEX]
    const p = new Promise((resolve, reject) => {
        this.once(`buggy-response`, (data) => {
            let responseData = Buffer.from(data)
            resolve(responseData)
        }).then((data) => {
            return Promise.resolve(data[5] << 7 | data[4])
        })
        setTimeout(_ => reject(new Error('buggy response timeout')), 500)
    })
    writeToTransport(this, msg)
    return p
}

Board.prototype.init = function () {
    console.log('Firmata init....')
    this.ports = new Array(16).fill(0)
    // board.pins = [];

    for (let i = 0; i < this.pins.length; i++) {
        this.pins[i].mode = null
    }

    ideaboardLed = 0
    sensorPrepareMap = new Map()
    I2CActived = false
    i2cInputData = []
    i2cOutputData = new Map()
    motionData = []
    dotMaxtrixBuffer = null
    joystick = []
    irCode = 0
    irData = { '0x1FE48B7': {},
        '0x1FE807F': {},
        '0x1FE40BF': {},
        '0x1FEC03F': {},
        '0x1FE20DF': {},
        '0x1FE609F': {},
        '0x1FEA05F': {},
        '0x1FED827': {},
        '0x1FEE01F': {},
        '0x1FE906F': {},
        '0x1FE10EF': {},
        '0x1FE50AF': {},
        '0x1FEF807': {},
        '0x1FE708F': {},
        '0x1FEB04F': {},
        '0x1FE30CF': {} }

    // firmata init all digital port as 'Digital output low'
    // init all analog port as 'Analog input'

    // report all digital input & set sample interval to 100ms

    return writeToTransport(this, [0xF0, 0x7A, 0x64, 0x00, 0xF7])
        .then(_ => {
            this.isClean = true
        })
}

/**
 * Asks the arduino to tell us its capabilities
 * @param {function} callback A function to call when we receive the capabilities
 */

Board.prototype.queryCapabilities = function (callback) {
    this.once('capability-query', callback)
    return writeToTransport(this, [START_SYSEX, CAPABILITY_QUERY, END_SYSEX])
}

/**
 * Asks the arduino to tell us its analog pin mapping
 * @param {function} callback A function to call when we receive the pin mappings.
 */

Board.prototype.queryAnalogMapping = function (callback) {
    this.once('analog-mapping-query', callback)
    return writeToTransport(this, [START_SYSEX, ANALOG_MAPPING_QUERY, END_SYSEX])
}

/**
 * Asks the arduino to tell us the current state of a pin
 * @param {number} pin The pin we want to the know the state of
 * @param {function} callback A function to call when we receive the pin state.
 */

Board.prototype.queryPinState = function (pin, callback) {
    this.once(`pin-state-${pin}`, callback)
    return writeToTransport(this, [START_SYSEX, PIN_STATE_QUERY, pin, END_SYSEX])
}

/**
 * Sends a string to the arduino
 * @param {String} string to send to the device
 */

Board.prototype.sendString = function (string) {
    const bytes = Buffer.from(`${string}\0`, 'utf8')
    const data = []
    data.push(START_SYSEX)
    data.push(STRING_DATA)
    for (let i = 0, length = bytes.length; i < length; i++) {
        data.push(bytes[i] & 0x7F)
        data.push((bytes[i] >> 7) & 0x7F)
    }
    data.push(END_SYSEX)

    return writeToTransport(this, data)
}

/**
 * Set sampling interval in millis. Default is 19 ms
 * @param {number} interval The sampling interval in ms > 10
 */

Board.prototype.setSamplingInterval = function (interval) {
    const safeint = interval < 10 ? 10 : (interval > 65535 ? 65535 : interval)
    this.settings.samplingInterval = safeint
    return writeToTransport(this, [
        START_SYSEX,
        SAMPLING_INTERVAL,
        (safeint & 0x7F),
        ((safeint >> 7) & 0x7F),
        END_SYSEX
    ])
}

/**
 * Get sampling interval in millis. Default is 19 ms
 *
 * @return {number} samplingInterval
 */

Board.prototype.getSamplingInterval = function () {
    return this.settings.samplingInterval
}

/**
 * Set reporting on pin
 * @param {number} pin The pin to turn on/off reporting
 * @param {number} value Binary value to turn reporting on/off
 */

Board.prototype.reportAnalogPin = function (pin, value) {
    /* istanbul ignore else */
    if (value === 0 || value === 1) {
        return writeToTransport(this, [REPORT_ANALOG | pin, value]).then(() => {
            this.pins[this.analogPins[pin]].report = value
        })
    }
    return Promise.reject(new Error('Invalid report analog'))
}

/**
 * Set reporting on pin
 * @param {number} pin The pin to turn on/off reporting
 * @param {number} value Binary value to turn reporting on/off
 */

Board.prototype.reportDigitalPin = function (pin, value) {
    const port = pin >> 3
    /* istanbul ignore else */
    if (value === 0 || value === 1) {
        return writeToTransport(this, [REPORT_DIGITAL | port, value]).then(() => {
            this.pins[pin].report = value
        })
    }
    return Promise.reject(new Error('Invalid report digital'))
}

/**
 *
 *
 */

Board.prototype.pingRead = function (opts, callback) {
    if (this.pins[opts.pin].supportedModes.indexOf(PING_READ) === -1) {
        throw new Error('Please upload PingFirmata to the board')
    }

    const pin = opts.pin
    const value = opts.value
    const pulseOut = opts.pulseOut || 0
    const timeout = opts.timeout || 1000000
    const pulseOutArray = [
        (pulseOut >> 24) & 0xFF,
        (pulseOut >> 16) & 0xFF,
        (pulseOut >> 8) & 0xFF,
        (pulseOut & 0xFF)
    ]
    const timeoutArray = [
        (timeout >> 24) & 0xFF,
        (timeout >> 16) & 0xFF,
        (timeout >> 8) & 0xFF,
        (timeout & 0xFF)
    ]

    return writeToTransport(this, [
        START_SYSEX,
        PING_READ,
        pin,
        value,
        pulseOutArray[0] & 0x7F, (pulseOutArray[0] >> 7) & 0x7F,
        pulseOutArray[1] & 0x7F, (pulseOutArray[1] >> 7) & 0x7F,
        pulseOutArray[2] & 0x7F, (pulseOutArray[2] >> 7) & 0x7F,
        pulseOutArray[3] & 0x7F, (pulseOutArray[3] >> 7) & 0x7F,
        timeoutArray[0] & 0x7F, (timeoutArray[0] >> 7) & 0x7F,
        timeoutArray[1] & 0x7F, (timeoutArray[1] >> 7) & 0x7F,
        timeoutArray[2] & 0x7F, (timeoutArray[2] >> 7) & 0x7F,
        timeoutArray[3] & 0x7F, (timeoutArray[3] >> 7) & 0x7F,
        END_SYSEX
    ])
}

/**
 * Stepper functions to support AdvancedFirmata"s asynchronous control of stepper motors
 * https://github.com/soundanalogous/AdvancedFirmata
 */

/**
 * Asks the arduino to configure a stepper motor with the given config to allow asynchronous control of the stepper
 * @param {number} deviceNum Device number for the stepper (range 0-5, expects steppers to be setup in order from 0 to 5)
 * @param {number} type One of this.STEPPER.TYPE.*
 * @param {number} stepsPerRev Number of steps motor takes to make one revolution
 * @param {number} dirOrMotor1Pin If using EasyDriver type stepper driver, this is direction pin, otherwise it is motor 1 pin
 * @param {number} stepOrMotor2Pin If using EasyDriver type stepper driver, this is step pin, otherwise it is motor 2 pin
 * @param {number} [motor3Pin] Only required if type == this.STEPPER.TYPE.FOUR_WIRE
 * @param {number} [motor4Pin] Only required if type == this.STEPPER.TYPE.FOUR_WIRE
 */

Board.prototype.stepperConfig = function (deviceNum, type, stepsPerRev, dirOrMotor1Pin, stepOrMotor2Pin, motor3Pin, motor4Pin) {
    const data = [
        START_SYSEX,
        STEPPER,
        0x00, // STEPPER_CONFIG from firmware
        deviceNum,
        type,
        stepsPerRev & 0x7F, (stepsPerRev >> 7) & 0x7F,
        dirOrMotor1Pin,
        stepOrMotor2Pin
    ]
    if (type === this.STEPPER.TYPE.FOUR_WIRE) {
        data.push(motor3Pin, motor4Pin)
    }
    data.push(END_SYSEX)
    return writeToTransport(this, data)
}

/**
 * Asks the arduino to move a stepper a number of steps at a specific speed
 * (and optionally with and acceleration and deceleration)
 * speed is in units of .01 rad/sec
 * accel and decel are in units of .01 rad/sec^2
 * TODO: verify the units of speed, accel, and decel
 * @param {number} deviceNum Device number for the stepper (range 0-5)
 * @param {number} direction One of this.STEPPER.DIRECTION.*
 * @param {number} steps Number of steps to make
 * @param {number} speed
 * @param {number|function} accel Acceleration or if accel and decel are not used, then it can be the callback
 * @param {number} [decel]
 * @param {function} [callback]
 */

Board.prototype.stepperStep = function (deviceNum, direction, steps, speed, accel, decel, callback) {
    if (typeof accel === 'function') {
        callback = accel
        accel = 0
        decel = 0
    }

    const data = [
        START_SYSEX,
        STEPPER,
        0x01, // STEPPER_STEP from firmware
        deviceNum,
        direction, // one of this.STEPPER.DIRECTION.*
        steps & 0x7F, (steps >> 7) & 0x7F, (steps >> 14) & 0x7F,
        speed & 0x7F, (speed >> 7) & 0x7F
    ]
    if (accel > 0 || decel > 0) {
        data.push(
            accel & 0x7F, (accel >> 7) & 0x7F,
            decel & 0x7F, (decel >> 7) & 0x7F
        )
    }
    data.push(END_SYSEX)
    return writeToTransport(this, data)
}

/**
 * Asks the Arduino to configure a hardware or serial port.
 * @param {object} options Options:
 *   portId {number} The serial port to use (HW_SERIAL1, HW_SERIAL2, HW_SERIAL3, SW_SERIAL0,
 *   SW_SERIAL1, SW_SERIAL2, SW_SERIAL3)
 *   baud {number} The baud rate of the serial port
 *   rxPin {number} [SW Serial only] The RX pin of the SoftwareSerial instance
 *   txPin {number} [SW Serial only] The TX pin of the SoftwareSerial instance
 */

Board.prototype.serialConfig = function (options) {
    let portId
    let baud
    let rxPin
    let txPin

    /* istanbul ignore else */
    if (typeof options === 'object' && options !== null) {
        portId = options.portId
        baud = options.baud
        rxPin = options.rxPin
        txPin = options.txPin
    }

    /* istanbul ignore else */
    if (typeof portId === 'undefined') {
        throw new TypeError('portId must be specified, see SERIAL_PORT_IDs for options.')
    }

    baud = baud || 57600

    const data = [
        START_SYSEX,
        SERIAL_MESSAGE,
        SERIAL_CONFIG | portId,
        baud & 0x007F,
        (baud >> 7) & 0x007F,
        (baud >> 14) & 0x007F
    ]
    if (portId > 7 && typeof rxPin !== 'undefined' && typeof txPin !== 'undefined') {
        data.push(rxPin)
        data.push(txPin)
    } else if (portId > 7) {
        throw new Error('Both RX and TX pins must be defined when using Software Serial.')
    }

    data.push(END_SYSEX)
    return writeToTransport(this, data)
}

/**
 * Write an array of bytes to the specified serial port.
 * @param {number} portId The serial port to write to.
 * @param {Array} inBytes An array of bytes to write to the serial port.
 */

Board.prototype.serialWrite = function (portId, inBytes) {
    const data = [
        START_SYSEX,
        SERIAL_MESSAGE,
        SERIAL_WRITE | portId
    ]
    for (let i = 0, len = inBytes.length; i < len; i++) {
        data.push(inBytes[i] & 0x007F)
        data.push((inBytes[i] >> 7) & 0x007F)
    }
    data.push(END_SYSEX)
    /* istanbul ignore else */
    if (inBytes.length > 0) {
        return writeToTransport(this, data)
    }
}

/**
 * Start continuous reading of the specified serial port. The port is checked for data each
 * iteration of the main Arduino loop.
 * @param {number} portId The serial port to start reading continuously.
 * @param {number} maxBytesToRead [Optional] The maximum number of bytes to read per iteration.
 * If there are less bytes in the buffer, the lesser number of bytes will be returned. A value of 0
 * indicates that all available bytes in the buffer should be read.
 * @param {function} callback A function to call when we have received the bytes.
 */

Board.prototype.serialRead = function (portId) {
    const data = [
        START_SYSEX,
        SERIAL_MESSAGE,
        SERIAL_READ | portId,
        this.SERIAL_MODES.CONTINUOUS_READ
    ]

    data.push(END_SYSEX)
    return writeToTransport(this, data)
}

/**
 * Stop continuous reading of the specified serial port. This does not close the port, it stops
 * reading it but keeps the port open.
 * @param {number} portId The serial port to stop reading.
 */

Board.prototype.serialStop = function (portId) {
    return writeToTransport(this, [
        START_SYSEX,
        SERIAL_MESSAGE,
        SERIAL_READ | portId,
        this.SERIAL_MODES.STOP_READING,
        END_SYSEX
    ])
}

/**
 * Close the specified serial port.
 * @param {number} portId The serial port to close.
 */

Board.prototype.serialClose = function (portId) {
    return writeToTransport(this, [
        START_SYSEX,
        SERIAL_MESSAGE,
        SERIAL_CLOSE | portId,
        END_SYSEX
    ])
}

/**
 * Flush the specified serial port. For hardware serial, this waits for the transmission of
 * outgoing serial data to complete. For software serial, this removed any buffered incoming serial
 * data.
 * @param {number} portId The serial port to flush.
 */

Board.prototype.serialFlush = function (portId) {
    return writeToTransport(this, [
        START_SYSEX,
        SERIAL_MESSAGE,
        SERIAL_FLUSH | portId,
        END_SYSEX
    ])
}

/**
 * For SoftwareSerial only. Only a single SoftwareSerial instance can read data at a time.
 * Call this method to set this port to be the reading port in the case there are multiple
 * SoftwareSerial instances.
 * @param {number} portId The serial port to listen on.
 */

Board.prototype.serialListen = function (portId) {
    // listen only applies to software serial ports
    if (portId < 8) {
        return
    }
    return writeToTransport(this, [
        START_SYSEX,
        SERIAL_MESSAGE,
        SERIAL_LISTEN | portId,
        END_SYSEX
    ])
}

/**
 * Allow user code to handle arbitrary sysex responses
 *
 * @param {number} commandByte The commandByte must be associated with some message
 *                             that's expected from the slave device. The handler is
 *                             called with an array of _raw_ data from the slave. Data
 *                             decoding must be done within the handler itself.
 *
 *                             Use Board.decode(data) to extract useful values from
 *                             the incoming response data.
 *
 *  @param {function} handler Function which handles receipt of responses matching
 *                            commandByte.
 */

Board.prototype.sysexResponse = function (commandByte, handler) {
    if (Board.SYSEX_RESPONSE[commandByte]) {
        throw new Error(`${commandByte} is not an available SYSEX_RESPONSE byte`)
    }

    Board.SYSEX_RESPONSE[commandByte] = function (board) {
        handler.call(board, board.currentBuffer.slice(2, -1))
    }

    return this
}

/**
 * Allow user code to send arbitrary sysex messages
 *
 * @param {Array} message The message array is expected to be all necessary bytes
 *                        between START_SYSEX and END_SYSEX (non-inclusive). It will
 *                        be assumed that the data in the message array is
 *                        already encoded as 2 7-bit bytes LSB first.
 *
 *
 */

Board.prototype.sysexCommand = function (message) {
    if (!message || message.length === 0) {
        throw new Error('Sysex Command cannot be empty')
    }

    const data = message.slice()

    data.unshift(START_SYSEX)
    data.push(END_SYSEX)

    return writeToTransport(this, data)
}

/**
 * Send SYSTEM_RESET to arduino
 */

Board.prototype.reset = function () {
    if (this.isClean) {
        return
    }
    buzzerSongStop = true
    colorLEDFlashStop = true
    return writeToTransport(this, [SYSTEM_RESET])
}

/**
 * Board.isAcceptablePort Determines if a `port` object (from SerialPort.list(...))
 * is a valid Arduino (or similar) device.
 * @return {Boolean} true if port can be connected to by Firmata
 */

Board.isAcceptablePort = function (port) {
    const rport = /usb|acm|^com/i

    if (rport.test(port.comName)) {
        return true
    }

    return false
}

/**
 * Board.requestPort(callback) Request an acceptable port to connect to.
 * callback(error, port)
 */

Board.requestPort = function (callback) {
    com.list((ports) => {
        const port = ports.find(port => {
            if (Board.isAcceptablePort(port)) {
                return port
            }
        })

        if (port) {
            callback(null, port)
        } else {
            callback(new Error('No Acceptable Port Found'), null)
        }
    })
}

// For backwards compatibility
Board.Board = Board
Board.SYSEX_RESPONSE = SYSEX_RESPONSE
Board.MIDI_RESPONSE = MIDI_RESPONSE

// Expose encode/decode for custom sysex messages
Board.encode = function (data) {
    const encoded = []
    const length = data.length

    for (let i = 0; i < length; i++) {
        encoded.push(
            data[i] & 0x7F,
            (data[i] >> 7) & 0x7F
        )
    }

    return encoded
}

Board.decode = function (data) {
    const decoded = []

    if (data.length % 2 !== 0) {
        throw new Error('Board.decode(data) called with odd number of data bytes')
    }

    while (data.length) {
        const lsb = data.shift()
        const msb = data.shift()
        decoded.push(lsb | (msb << 7))
    }

    return decoded
}

module.exports = Board
