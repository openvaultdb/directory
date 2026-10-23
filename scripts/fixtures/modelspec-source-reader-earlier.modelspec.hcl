entity "Order-Line" {
  use = ["Left","chinook.Left","Right"]
  property "shared" {
    type = "bool"
  }
  property "nested" {
    component = "Node"
  }
  field "a.b" {
    type = "int"
  }
  field "target" {
    entity = "chinook.Target"
  }
}
record "Empty" {
}
record "Target" {
}
record "﻿" {
}
component "Left" {
  field "shared" {
    entity = "Target"
  }
  field "field-name" {
    type = "string"
    enum = "State"
  }
}
component "Right" {
  field "shared" {
    type = "int"
  }
}
component "Node" {
  field "self" {
    component = "chinook.Node"
  }
  field "target" {
    entity = "Target"
  }
}
enum "State" {
  values = ["open","closed"]
}
