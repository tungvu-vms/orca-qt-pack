cmake_minimum_required(VERSION 3.21)
project(demo LANGUAGES CXX)
find_package(Qt6 REQUIRED COMPONENTS Quick)
qt_add_executable(demo main.cpp)
