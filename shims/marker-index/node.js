module.exports = class Node {
  constructor (parent, leftExtent) {
    this.parent = parent
    this.left = null
    this.right = null
    this.leftExtent = leftExtent
    this.leftMarkerIds = new Set()
    this.rightMarkerIds = new Set()
    this.startMarkerIds = new Set()
    this.endMarkerIds = new Set()
    this.priority = null
    this.id = this.constructor.idCounter++
  }

  isMarkerEndpoint () {
    return (this.startMarkerIds.size + this.endMarkerIds.size) > 0
  }
}

Node.idCounter = 1
