record "Order-Line" {
  use = ["Left","chinook.Left","Right"]
  field "shared" {
    type = "bool"
  }
  field "nested" {
    component = "Node"
  }
  field "a.b" {
    type = "int"
  }
  field "target" {
    record = "chinook.Target"
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
    record = "Target"
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
    record = "Target"
  }
}
enum "State" {
  values = ["open","closed"]
}
