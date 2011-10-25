// parse a 512-byte header block to a data object, or vice-versa
// If the data won't fit nicely in a simple header, then generate
// the appropriate extended header file, and return that.

module.exports = TarHeader

var tar = require("../tar.js")
  , fields = tar.fields
  , fieldOffs = tar.fieldOffs
  , fieldEnds = tar.fieldEnds
  , assert = require("assert").ok
  , space = " ".charCodeAt(0)

function TarHeader (block) {
  if (!(this instanceof TarHeader)) return new TarHeader(block)
  if (block) this.decode(block)
}

TarHeader.prototype =
  { decode : decode
  , encode: encode
  , calcSum: calcSum
  , checkSum: checkSum
  }

TarHeader.parseNumeric = parseNumeric
TarHeader.encode = encode
TarHeader.decode = decode

// note that this will only do the normal ustar header, not any kind
// of extended posix header file.  If something doesn't fit comfortably,
// then it will set obj.needsExtendedHeader=true, and set the block to
// the closest approximation.
function encode (obj) {
  if (!obj && !(this instanceof TarHeader)) throw new Error(
    "encode must be called on a TarHeader, or supplied an object")

  obj = obj || this
  var block = obj.block = new Buffer(tar.headerSize)
  for (var i = 0; i < tar.headerSize; i ++) block[i] = 0

  // console.error("encode", obj)

  // console.error("\n\nabout to enter Object.keys\n")
  for (var f = 0; fields[f] !== null; f ++) {
    var field = fields[f]
      , off = fieldOffs[f]
      , end = fieldEnds[f]

    // console.error("field", f, field, off, end, obj[field])

    switch (field) {
      case "mode":
      case "uid":
      case "gid":
      case "size":
      case "mtime":
      case "devmaj":
      case "devmin":
        writeNumeric(block, off, end, obj[field])
        break

      case "cksum":
        // special, done below, after all the others
        break

      // all other fields are text
      default:
        // console.error("writeText %j %j", f, field, obj[field])
        obj.needExtended = writeText(block, off, end, obj[field] || "")
        break
    }
  }

  var off = fieldOffs[fields.cksum]
    , end = fieldEnds[fields.cksum]

  writeNumeric(block, off, end, calcSum.call(this, block))

  return block
}

// if it's a negative number, or greater than will fit,
// then use write256.
var MAXNUM = { 12: 077777777777
             , 11: 07777777777
             , 8 : 07777777
             , 7 : 0777777 }
function writeNumeric (block, off, end, num) {
  var writeLen = end - off
    , maxNum = MAXNUM[writeLen] || 0

  if (num > maxNum || num < 0) return write256(block, off, end, num)

  // god, tar is so annoying
  // if the string is small enough, you should put a space
  // between the octal string and the \0, but if it doesn't
  // fit, then don't.
  var numStr = num.toString(8)
  if (num < MAXNUM[writeLen - 1]) numStr += " "

  // pad with "0" chars
  if (numStr.length < writeLen) {
    numStr = (new Array(writeLen - numStr.length).join("0")) + numStr
  }

  if (numStr.length !== writeLen - 1) throw new Error(numStr)
  block.write(numStr, off, writeLen, "ascii")
  block[end - 1] = 0
  // console.error("writeNumeric [%j,%j] %j -> %j", off, end, num,
  //               block.slice(off, end).toString())
}

function write256 (block, off, end, num) {
  var buf = block.slice(off, end)
  var positive = num >= 0
  buf[0] = positive ? 0x80 : 0xFF

  // get the number as a base-256 tuple
  if (!positive) num *= -1
  var tuple = []
  do {
    var n = num % 256
    tuple.push(n)
    num = (num - n) / 256
  } while (num)

  var bytes = tuple.length

  var fill = buf.length - bytes
  for (var i = 1; i < fill; i ++) {
    buf[i] = positive ? 0 : 0xFF
  }

  // now tuple is a base256 number, with [0] as the *least* significant byte
  // if it's negative, then we need to flip all the bits once we hit the
  // first non-zero bit.  The 2's-complement is (0x100 - n), and the 1's-
  // complement is (0xFF - n).
  var zero = true
  for (i = bytes; i > 0; i --) {
    var byte = tuple[bytes - i]
    if (positive) buf[fill + i] = byte
    else if (zero && byte === 0) buf[fill + i] = 0
    else if (zero) {
      zero = false
      buf[fill + i] = 0x100 - byte
    } else buf[fill + i] = 0xFF - byte
  }
}

function writeText (block, off, end, str) {
  // strings are written as ascii, then padded with \0
  var strLen = Buffer.byteLength(str)
    , writeLen = Math.min(strLen, end - off)
    // non-ascii fields need extended headers
    // long fields get truncated
    , needExtended = strLen !== str.length || strLen > writeLen

  // console.error("str=%j writeLen=%j end=%j off=%j off+writeLen=%j", str
  //              , writeLen, end, off, off+writeLen)

  // write the string, and null-pad
  if (writeLen > 0) block.write(str, off, writeLen, "utf8")
  for (var i = off + writeLen; i < end; i ++) block[i] = 0

  return needExtended
}

function calcSum (block) {
  block = block || this.block
  assert(Buffer.isBuffer(block) && block.length === tar.headerSize)

  if (!block) throw new Error("Need block to checksum")

  // now figure out what it would be if the cksum was "        "
  var sum = 0
    , start = fieldOffs[fields.cksum]
    , end = fieldEnds[fields.cksum]

  for (var i = 0; i < fieldOffs[fields.cksum]; i ++) {
    sum += block[i]
  }

  for (var i = start; i < end; i ++) {
    sum += space
  }

  for (var i = end; i < tar.headerSize; i ++) {
    sum += block[i]
  }

  return sum
}


function checkSum (block) {
  var sum = calcSum.call(this, block)
  block = block || this.block

  var cksum = block.slice(fieldOffs[fields.cksum], fieldEnds[fields.cksum])
  cksum = parseNumeric(cksum)

  return cksum === sum
}

function decode (block) {
  block = block || this.block
  assert(Buffer.isBuffer(block) && block.length === tar.headerSize)

  this.block = block
  this.cksumValid = this.checkSum()

  // slice off each field.
  FOR: for (var f = 0; fields[f] !== null; f ++) {
    var field = fields[f]
    var val = block.slice(fieldOffs[f], fieldEnds[f])

    switch (field) {
      case "mode":
      case "uid":
      case "gid":
      case "size":
      case "mtime":
      case "devmaj":
      case "devmin":
      case "cksum":
        this[field] = parseNumeric(val)
        break

      case "ustar":
        // if not ustar, then everything after that is invalid.
        if (val.toString() !== "ustar\0") {
          this.ustar = false
          break FOR
        } else {
          this.ustar = "ustar"
        }
        break

      // prefix is special, since it might signal the xstar header
      case "prefix":
        var atime = parseNumeric(val.slice(131, 131 + 12))
          , ctime = parseNumeric(val.slice(131 + 12, 131 + 12 + 12))
        if ((val[130] === 0 || val[130] === space) &&
            typeof atime === "number" &&
            typeof ctime === "number" &&
            val[131 + 12] === space &&
            val[131 + 12 + 12] === space) {
          this.atime = atime
          this.ctime = ctime
          val = val.slice(0, 130)
        }
        this.prefix = val.toString("ascii").replace(/\0+$/, "")
        break

      // all other fields are null-padding ascii text
      default:
        this[field] = val.toString("ascii").replace(/\0+$/, "")
        break
    }
  }

}

function parse256 (buf) {
  // first byte MUST be either 80 or FF
  // 80 for positive, FF for 2's comp
  var positive
  if (buf[0] === 0x80) positive = true
  else if (buf[0] === 0xFF) positive = false
  else return null

  // build up a base-256 tuple from the least sig to the highest
  var zero = false
    , tuple = []
  for (var i = buf.length - 1; i > 0; i --) {
    var byte = buf[i]
    if (positive) tuple.push(byte)
    else if (zero && byte === 0) tuple.push(0)
    else if (zero) {
      zero = false
      tuple.push(0x100 - byte)
    } else tuple.push(0xFF - byte)
  }

  for (var sum = 0, i = 0, l = tuple.length; i < l; i ++) {
    sum += tuple[i] * Math.pow(256, i)
  }

  return positive ? sum : -1 * sum
}

function parseNumeric (f) {
  if (f[0] & 0x80) return parse256(f)

  var str = f.toString("ascii").split("\0")[0].trim()
    , res = parseInt(str, 8)

  // console.error("parseNumeric %j %j %j", f.toString("hex"), str, res)
  return isNaN(res) ? null : res
}
