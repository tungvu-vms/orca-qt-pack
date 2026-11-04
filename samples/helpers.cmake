# Helper module
function(add_qt_app name)
  qt_add_executable(${name} main.cpp)
  target_link_libraries(${name} PRIVATE Qt6::Widgets Qt6::Qml)
  set_target_properties(${name} PROPERTIES WIN32_EXECUTABLE ON)
endfunction()
