module.exports.addToSet = function addToSet (target, source) {
  source.forEach(target.add, target)
}
